/**
 * server.js - the only process. Serves the page and the JSON the page reads.
 *
 * The GoHighLevel token never leaves this process: the browser only ever
 * receives finished numbers. Every GHL request goes through lib/ghl.js, which
 * refuses anything that is not a GET or a documented search endpoint.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, missingConfig } from './lib/env.js';
import { GhlClient, GhlError } from './lib/ghl.js';
import { TtlCache } from './lib/cache.js';
import { buildReport } from './lib/report.js';
import { dayRangeToUtc, presetRange, isValidTimezone, parseDay } from './lib/tz.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, 'public');
const MAX_RANGE_DAYS = 92;

const cache = new TtlCache(config.cacheTtlMs);
let ghl = null;
if (!missingConfig().length) {
  ghl = new GhlClient({ token: config.token, locationId: config.locationId, apiBase: config.apiBase });
}

/* ---------------- helpers ---------------- */

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  const payload = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(payload);
}

function errorPayload(err) {
  if (err instanceof GhlError && err.isAuth) {
    return {
      ok: false,
      error: {
        type: 'auth',
        status: err.status,
        message:
          err.status === 401
            ? 'GoHighLevel rejected the token (401). Check that the GHL_TOKEN secret holds a valid Private Integration Token for this sub-account.'
            : 'GoHighLevel refused the request (403). The token is valid but is missing a scope. It needs contacts.readonly, conversations.readonly, conversations/message.readonly, users.readonly, locations.readonly and locations/customFields.readonly.',
        detail: err.message,
      },
    };
  }
  if (err instanceof GhlError) {
    return { ok: false, error: { type: 'ghl', status: err.status, message: `GoHighLevel error ${err.status || ''}: ${err.message}`.trim() } };
  }
  return { ok: false, error: { type: 'server', message: err?.message || String(err) } };
}

function checkAuth(req, res) {
  if (!config.password) return true;
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const pw = decoded.slice(decoded.indexOf(':') + 1);
    if (pw === config.password) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OptiVet reporting"', 'Content-Type': 'text/plain' });
  res.end('Password required');
  return false;
}

async function accountMeta() {
  const { value } = await cache.get('meta', async () => {
    const loc = await ghl.getLocation();
    return { name: loc.name || '', timezone: loc.timezone || '', locationId: config.locationId };
  }, { ttlMs: 60 * 60 * 1000 });
  return value;
}

function resolveRange(params, tz) {
  let from = params.get('from');
  let to = params.get('to');
  const preset = params.get('preset');
  if (!from || !to) {
    ({ from, to } = presetRange(preset || 'today', tz));
  }
  if (!parseDay(from) || !parseDay(to)) throw new Error('from/to must be YYYY-MM-DD');
  const { startMs, endMs } = dayRangeToUtc(from, to, tz);
  const days = Math.round((endMs + 1 - startMs) / 86400000);
  if (days > MAX_RANGE_DAYS) throw new Error(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  return { from, to, startMs, endMs };
}

async function getReport(params) {
  const meta = await accountMeta();
  const tz = (config.timezone && isValidTimezone(config.timezone) && config.timezone) || (isValidTimezone(meta.timezone) && meta.timezone) || 'America/New_York';
  const range = resolveRange(params, tz);
  const refresh = params.get('refresh') === '1';
  const key = `report:${range.from}:${range.to}`;
  const { value, cachedAt, fromCache } = await cache.get(
    key,
    () => buildReport({ ghl, config, from: range.from, to: range.to, tz, startMs: range.startMs, endMs: range.endMs, meta }),
    { refresh },
  );
  return { ...value, cachedAt: new Date(cachedAt).toISOString(), fromCache, cacheTtlSeconds: config.cacheTtlMs / 1000 };
}

function csvEscape(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function serveStatic(req, res, urlPath) {
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.normalize(path.join(PUBLIC, file));
  if (!abs.startsWith(PUBLIC + path.sep) && abs !== path.join(PUBLIC, 'index.html')) return send(res, 404, 'Not found');
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'Not found');
  const ext = path.extname(abs);
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  });
  fs.createReadStream(abs).pipe(res);
}

/* ---------------- router ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  if (!checkAuth(req, res)) return;

  try {
    if (p === '/api/health') {
      const missing = missingConfig();
      return send(res, 200, { ok: missing.length === 0, configured: missing.length === 0, missing, cacheTtlSeconds: config.cacheTtlMs / 1000, messageSource: config.messageSource });
    }

    if (p === '/api/report' || p === '/api/data-quality.csv') {
      const missing = missingConfig();
      if (missing.length) {
        return send(res, 500, { ok: false, error: { type: 'config', message: `Missing secrets: ${missing.join(', ')}. Add them to the environment (Secrets) and restart.` } });
      }
      const report = await getReport(url.searchParams);
      if (p === '/api/report') return send(res, 200, report);

      const lines = [['Name', 'Created (local)', 'Created (ISO)', 'Missing', 'Care path', 'Products requested', 'Contact ID'].join(',')];
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: report.range.tz, dateStyle: 'medium', timeStyle: 'short' });
      for (const r of report.dataQuality.rows) {
        lines.push([r.name, fmt.format(new Date(r.createdAt)), r.createdAt, r.missing.join(' + '), r.carePath || '', r.products.join('; '), r.id].map(csvEscape).join(','));
      }
      return send(res, 200, lines.join('\r\n') + '\r\n', {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="optivet-data-quality-${report.range.from}-to-${report.range.to}.csv"`,
      });
    }

    if (p.startsWith('/api/')) return send(res, 404, { ok: false, error: { type: 'server', message: 'Unknown endpoint' } });
    return serveStatic(req, res, p);
  } catch (err) {
    const payload = errorPayload(err);
    const status = payload.error.type === 'auth' ? 502 : payload.error.type === 'ghl' ? 502 : 400;
    console.error(`[${new Date().toISOString()}] ${req.method} ${p} -> ${payload.error.type}: ${payload.error.message}`);
    return send(res, status, payload);
  }
});

server.listen(config.port, () => {
  const missing = missingConfig();
  console.log(`OptiVet reporting dashboard listening on http://localhost:${config.port}`);
  if (missing.length) console.log(`WARNING: missing ${missing.join(', ')} - the dashboard will show a configuration error until they are set.`);
  else console.log(`Location ${config.locationId}, cache ${config.cacheTtlMs / 1000}s, message source "${config.messageSource}"${config.password ? ', password protected' : ''}`);
});
