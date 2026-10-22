/**
 * env.js - configuration.
 *
 * Reads from process.env first (Replit Secrets, Vercel/Render env vars, a
 * shell export). For local development it falls back to the client folder's
 * `.env` one level up (which is a symlink to ghl-credentials.env) so the token
 * never has to be copied anywhere. The token is never logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const out = {};
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
    return out;
  } catch {
    return {};
  }
}

// Only consulted for keys that are not already in process.env.
const fallback = {
  ...loadDotEnv(path.join(here, '..', '.env')),
  ...loadDotEnv(path.join(here, '..', '..', '.env')),
};

function pick(...names) {
  for (const n of names) {
    if (process.env[n] && String(process.env[n]).trim()) return String(process.env[n]).trim();
  }
  for (const n of names) {
    if (fallback[n] && String(fallback[n]).trim()) return String(fallback[n]).trim();
  }
  return '';
}

export const config = {
  token: pick('GHL_TOKEN', 'GHL_PIT'),
  locationId: pick('GHL_LOCATION_ID'),
  apiBase: pick('GHL_API_BASE') || 'https://services.leadconnectorhq.com',
  port: Number(pick('PORT')) || 3000,
  cacheTtlMs: (Number(pick('CACHE_TTL_SECONDS')) || 900) * 1000,
  timezone: pick('DASHBOARD_TZ'), // blank = use the sub-account's own timezone
  // Optional: protect the page with a password (HTTP Basic auth, any username).
  password: pick('DASHBOARD_PASSWORD'),
  // "auto" = bulk message export, falling back to the per-conversation walk.
  // "walk" forces the conversations/search -> /messages route from the brief.
  messageSource: (pick('MESSAGE_SOURCE') || 'auto').toLowerCase(),
  // Optional field overrides: comma-separated field names or IDs.
  fieldOverrides: {
    product: pick('FIELD_PRODUCT'),
    facility: pick('FIELD_FACILITY'),
    state: pick('FIELD_STATE'),
    postal: pick('FIELD_POSTAL'),
  },
};

export function missingConfig() {
  const missing = [];
  if (!config.token) missing.push('GHL_TOKEN');
  if (!config.locationId) missing.push('GHL_LOCATION_ID');
  return missing;
}
