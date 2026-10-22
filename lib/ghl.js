/**
 * ghl.js - the only file that talks to GoHighLevel.
 *
 * Guarantees, in order of importance:
 *  1. READ-ONLY. Only GET requests and the documented search endpoints are
 *     allowed through. Anything else throws before a byte leaves the server.
 *  2. RATE LIMITED. GHL allows 100 requests per 10 seconds per token. We run
 *     a sliding window at 85 with limited concurrency, and back off on 429.
 *  3. PAGINATES EVERYTHING. Each fetcher walks every page until the data is
 *     exhausted or clearly outside the requested window.
 *
 * Version headers: contacts/users/locations take "2021-07-28". The
 * /conversations endpoints need "2021-04-15" (the message export returns
 * HTTP 422 with the newer header). The token is never logged.
 */

const V_CORE = '2021-07-28';
const V_CONV = '2021-04-15';

// The allow-list. Method + path prefix. Nothing else gets out.
const ALLOWED = [
  { method: 'GET', test: () => true },
  { method: 'POST', test: (p) => p === '/contacts/search' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class GhlError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
  get isAuth() {
    return this.status === 401 || this.status === 403;
  }
}

class Limiter {
  constructor({ perWindow = 85, windowMs = 10_000, maxConcurrent = 8 } = {}) {
    this.perWindow = perWindow;
    this.windowMs = windowMs;
    this.maxConcurrent = maxConcurrent;
    this.stamps = [];
    this.active = 0;
    this.waiters = [];
  }
  async acquire() {
    for (;;) {
      const now = Date.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.active < this.maxConcurrent && this.stamps.length < this.perWindow) {
        this.stamps.push(now);
        this.active++;
        return;
      }
      if (this.stamps.length >= this.perWindow) {
        await sleep(this.windowMs - (now - this.stamps[0]) + 25);
      } else {
        await new Promise((resolve) => this.waiters.push(resolve));
      }
    }
  }
  release() {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export class GhlClient {
  constructor({ token, locationId, apiBase }) {
    if (!token || !locationId) throw new Error('GhlClient needs token and locationId');
    this.token = token;
    this.locationId = locationId;
    this.base = apiBase.replace(/\/$/, '');
    this.limiter = new Limiter();
    this.calls = 0;
  }

  /** One HTTP request with rate limiting and retry. Throws GhlError on a final failure. */
  async request(path, { method = 'GET', version = V_CORE, query, body, retries = 4 } = {}) {
    method = method.toUpperCase();
    const allowed = ALLOWED.some((r) => r.method === method && r.test(path));
    if (!allowed) throw new Error(`Blocked non-read request: ${method} ${path}`);

    const url = new URL(this.base + path);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
      }
    }
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Version: version,
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.limiter.acquire();
      let res;
      try {
        this.calls++;
        res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      } catch (err) {
        lastErr = new GhlError(0, `Network error reaching GoHighLevel: ${err.message}`);
        this.limiter.release();
        if (attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw lastErr;
      }
      this.limiter.release();

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const wait = retryAfter ? retryAfter * 1000 : Math.min(10_000, 800 * 2 ** attempt) + Math.random() * 300;
        lastErr = new GhlError(res.status, `GoHighLevel returned ${res.status}`, await safeText(res));
        if (attempt < retries) {
          await sleep(wait);
          continue;
        }
        throw lastErr;
      }

      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text.slice(0, 500) };
        }
      }
      if (!res.ok) {
        const msg = data?.message || data?.error || `HTTP ${res.status}`;
        throw new GhlError(res.status, Array.isArray(msg) ? msg.join('; ') : String(msg), data);
      }
      return data;
    }
    throw lastErr || new GhlError(0, 'Request failed');
  }

  /* ---------------------------------------------------------------- */

  async getLocation() {
    const d = await this.request(`/locations/${this.locationId}`);
    return d?.location || d || {};
  }

  async getUsers() {
    const d = await this.request('/users/', { query: { locationId: this.locationId } });
    return d?.users || [];
  }

  async getCustomFields() {
    const d = await this.request(`/locations/${this.locationId}/customFields`, { query: { model: 'contact' } });
    return d?.customFields || [];
  }

  /**
   * Every contact whose dateAdded is inside [startMs, endMs]. Uses the
   * search endpoint's dateAdded range filter and `searchAfter` cursors.
   */
  async getContactsAddedBetween(startMs, endMs, { pageLimit = 100, maxPages = 500 } = {}) {
    const out = [];
    const seen = new Set();
    let searchAfter = null;
    let total = null;
    for (let page = 0; page < maxPages; page++) {
      const body = {
        locationId: this.locationId,
        pageLimit,
        filters: [
          {
            group: 'AND',
            filters: [
              {
                field: 'dateAdded',
                operator: 'range',
                value: { gte: new Date(startMs).toISOString(), lte: new Date(endMs).toISOString() },
              },
            ],
          },
        ],
        sort: [{ field: 'dateAdded', direction: 'desc' }],
      };
      if (searchAfter) body.searchAfter = searchAfter;
      const d = await this.request('/contacts/search', { method: 'POST', body });
      if (total === null && typeof d?.total === 'number') total = d.total;
      const batch = d?.contacts || [];
      for (const c of batch) {
        if (c?.id && !seen.has(c.id)) {
          seen.add(c.id);
          out.push(c);
        }
      }
      if (batch.length < pageLimit) break;
      const last = batch[batch.length - 1];
      const next = last?.searchAfter || (last?.dateAdded ? [Date.parse(last.dateAdded), last.id] : null);
      if (!next || JSON.stringify(next) === JSON.stringify(searchAfter)) break;
      searchAfter = next;
    }
    return { contacts: out, total: total ?? out.length };
  }

  /**
   * Bulk message export for one channel ("SMS" | "Call") inside the window.
   * One call per 100 messages instead of one call per conversation.
   *
   * Two defensive habits, both learned from this account:
   *  - The window is pulled in one-day chunks. On spans of several days the
   *    endpoint sometimes answers `{messages: [], total: 0}` for a query it
   *    answered correctly a minute earlier; single days have never done that.
   *  - A chunk whose first page is empty is asked once more after a pause.
   *  - Keep `limit` at 100: at 200 the empty answer becomes the rule.
   */
  async exportMessages(channel, startMs, endMs, { limit = 100, chunkMs = 86_400_000, maxPagesPerChunk = 500, concurrency = 4 } = {}) {
    const windows = [];
    for (let s = startMs; s <= endMs; s += chunkMs) windows.push([s, Math.min(endMs, s + chunkMs - 1)]);

    const results = new Array(windows.length);
    let next = 0;
    const worker = async () => {
      while (next < windows.length) {
        const i = next++;
        results[i] = await this._exportChunk(channel, windows[i][0], windows[i][1], limit, maxPagesPerChunk);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));

    const out = [];
    const seen = new Set();
    let total = 0;
    const suspectWindows = [];
    const shortWindows = [];
    results.forEach((chunk, i) => {
      total += chunk.total;
      if (chunk.suspect) suspectWindows.push(new Date(windows[i][0]).toISOString());
      if (chunk.total > chunk.messages.length) shortWindows.push(new Date(windows[i][0]).toISOString());
      for (const m of chunk.messages) {
        if (m?.id && !seen.has(m.id)) {
          seen.add(m.id);
          out.push(m);
        }
      }
    });
    return { messages: out, total, channel, suspectWindows, shortWindows };
  }

  async _exportChunk(channel, startMs, endMs, limit, maxPages) {
    const messages = [];
    let cursor = null;
    let total = null;
    let suspect = false;
    for (let page = 0; page < maxPages; page++) {
      let d = await this._exportPage(channel, startMs, endMs, limit, cursor);
      let batch = d?.messages || d?.data || [];
      if (page === 0 && batch.length === 0 && !(Number(d?.total) > 0)) {
        // The endpoint's silent empty answer. Ask again, with growing pauses.
        for (const wait of [2000, 4000, 8000, 12000]) {
          await sleep(wait);
          d = await this._exportPage(channel, startMs, endMs, limit, cursor);
          batch = d?.messages || d?.data || [];
          if (batch.length || Number(d?.total) > 0) break;
        }
        if (batch.length === 0) {
          suspect = true;
          console.warn(`[ghl] ${channel} export stayed empty for ${new Date(startMs).toISOString()} after 5 attempts`);
        } else {
          console.warn(`[ghl] ${channel} export was empty on first try for ${new Date(startMs).toISOString()}; a retry answered`);
        }
      }
      if (total === null && typeof d?.total === 'number') total = d.total;
      messages.push(...batch);
      cursor = d?.nextCursor || null;
      if (!cursor || batch.length === 0) break;
    }
    return { messages, total: total ?? messages.length, suspect };
  }

  _exportPage(channel, startMs, endMs, limit, cursor) {
    return this.request('/conversations/messages/export', {
      version: V_CONV,
      query: {
        locationId: this.locationId,
        channel,
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(endMs).toISOString(),
        limit,
        cursor,
        sortBy: 'createdAt',
        sortOrder: 'desc',
      },
    });
  }

  /**
   * The route from the brief: conversations/search sorted by last message,
   * then /conversations/{id}/messages for each one that had a call or SMS.
   * Walks newest-first and stops once conversations predate the window.
   */
  async walkConversationMessages(startMs, endMs, { maxConversations = 4000, onProgress } = {}) {
    const convs = [];
    let startAfterDate = null;
    for (let page = 0; page < 500; page++) {
      const d = await this.request('/conversations/search', {
        version: V_CONV,
        query: {
          locationId: this.locationId,
          limit: 100,
          sortBy: 'last_message_date',
          sort: 'desc',
          startAfterDate,
        },
      });
      const batch = d?.conversations || [];
      if (!batch.length) break;
      let stop = false;
      for (const c of batch) {
        const t = Number(c.lastMessageDate) || 0;
        if (t < startMs) { stop = true; break; }
        // messageTypes: 1 = call, 2 = SMS. Skip email-only threads.
        const types = Array.isArray(c.messageTypes) ? c.messageTypes.map(Number) : null;
        if (types && !types.includes(1) && !types.includes(2)) continue;
        convs.push(c);
      }
      if (stop || batch.length < 100) break;
      startAfterDate = batch[batch.length - 1].lastMessageDate;
      if (convs.length >= maxConversations) break;
    }

    const capped = convs.length >= maxConversations;
    const messages = [];
    let done = 0;
    for (const c of convs.slice(0, maxConversations)) {
      let lastMessageId = null;
      for (let page = 0; page < 50; page++) {
        const d = await this.request(`/conversations/${c.id}/messages`, {
          version: V_CONV,
          query: { limit: 100, type: 'TYPE_CALL,TYPE_SMS', lastMessageId },
        });
        const m = d?.messages || {};
        const batch = Array.isArray(m) ? m : m.messages || [];
        let oldest = Infinity;
        for (const msg of batch) {
          const t = Date.parse(msg.dateAdded);
          if (t < oldest) oldest = t;
          if (t >= startMs && t <= endMs) messages.push({ ...msg, _assignedTo: c.assignedTo || null });
        }
        const nextPage = Array.isArray(m) ? false : m.nextPage;
        if (!nextPage || oldest < startMs || !batch.length) break;
        lastMessageId = (Array.isArray(m) ? null : m.lastMessageId) || batch[batch.length - 1].id;
      }
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, convs.length);
    }
    return { messages, conversations: convs.length, capped };
  }
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
