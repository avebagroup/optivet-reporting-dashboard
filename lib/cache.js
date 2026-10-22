/**
 * cache.js - a small in-memory TTL cache with in-flight de-duplication.
 *
 * Two readers asking for the same report at the same moment share one fetch.
 * A `refresh` request bypasses the stored value but still joins an in-flight
 * fetch, so a Refresh button mashed five times costs one pull.
 */
export class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map(); // key -> { at, value }
    this.inflight = new Map(); // key -> Promise
  }

  async get(key, producer, { refresh = false, ttlMs = this.ttlMs } = {}) {
    const hit = this.store.get(key);
    const now = Date.now();
    if (!refresh && hit && now - hit.at < ttlMs) {
      return { value: hit.value, cachedAt: hit.at, fromCache: true };
    }
    if (this.inflight.has(key)) {
      const value = await this.inflight.get(key);
      const entry = this.store.get(key);
      return { value, cachedAt: entry?.at ?? Date.now(), fromCache: false };
    }
    const p = (async () => {
      try {
        const value = await producer();
        this.store.set(key, { at: Date.now(), value });
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    const value = await p;
    return { value, cachedAt: this.store.get(key)?.at ?? Date.now(), fromCache: false };
  }

  peek(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    return { value: hit.value, cachedAt: hit.at, stale: Date.now() - hit.at >= this.ttlMs };
  }
}
