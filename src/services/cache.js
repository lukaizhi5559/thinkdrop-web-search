import { getConnection } from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';

const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false';
const CACHE_TTL_TIME_SENSITIVE = parseInt(process.env.CACHE_TTL_TIME_SENSITIVE) || 600000; // 10 minutes
const CACHE_TTL_GENERAL = parseInt(process.env.CACHE_TTL_GENERAL) || 86400000; // 24 hours

export function normalizeQuery(query, params = {}) {
  const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
  const paramStr = JSON.stringify(params);
  return `${normalized}|${paramStr}`;
}

export function getCacheTTL(query, params = {}) {
  // Time-sensitive queries get shorter TTL
  const timeSensitive = /\b(latest|recent|today|yesterday|news|breaking|current|now)\b/i.test(query);
  if (timeSensitive) {
    return CACHE_TTL_TIME_SENSITIVE;
  }
  
  // General queries get longer TTL
  return CACHE_TTL_GENERAL;
}

export async function getCachedResult(cacheKey) {
  if (!CACHE_ENABLED) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const conn = getConnection();
    const now = new Date().toISOString();
    const safeCacheKey = cacheKey.replace(/'/g, "''");

    conn.all(
      `SELECT * FROM search_cache WHERE normalized_query = '${safeCacheKey}' AND expires_at > '${now}'`,
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        if (rows && rows.length > 0) {
          const cached = rows[0];
          
          // Update hit count
          conn.exec(
            `UPDATE search_cache SET hit_count = hit_count + 1, last_accessed = '${now}' WHERE id = '${cached.id}'`,
            (updateErr) => {
              if (updateErr) {
                console.error('Failed to update cache hit count:', updateErr);
              }
            }
          );

          try {
            const results = JSON.parse(cached.results);
            resolve(results);
          } catch (parseErr) {
            console.error('Failed to parse cached results:', parseErr);
            resolve(null);
          }
        } else {
          resolve(null);
        }
      }
    );
  });
}

export async function setCachedResult(cacheKey, data, ttl) {
  if (!CACHE_ENABLED) {
    return;
  }

  // Don't cache failure responses — they poison subsequent queries for 24h.
  // The LLM fallback returns a single "Search providers unavailable" result
  // with an empty URL. Caching this means every query for the next 24 hours
  // returns the fake failure, breaking app-knowledge research entirely.
  if (data.provider === 'llm-fallback') {
    console.log('⏭️  Skipping cache for llm-fallback response (failure)');
    return;
  }
  if (data.results && data.results.length === 1) {
    const r = data.results[0];
    if (!r.url || r.provider === 'llm-fallback' || (r.title || '').includes('Search providers unavailable')) {
      console.log('⏭️  Skipping cache for failure response (no valid URL)');
      return;
    }
  }

  return new Promise((resolve, reject) => {
    const conn = getConnection();
    const id = `cache_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttl).toISOString();
    // Store the entire data object (including results, provider, total, etc.)
    const resultsJson = JSON.stringify(data);
    const query = data.query || 'unknown';
    const provider = data.provider || 'unknown';

    // Upsert: without the delete, a second write for the same key (e.g. the
    // post-enrichment rewrite) appends a new row while SELECT rows[0] keeps
    // returning the older un-enriched one.
    const sql = `DELETE FROM search_cache WHERE normalized_query = '${cacheKey.replace(/'/g, "''")}';
                 INSERT INTO search_cache (id, query, normalized_query, provider, results, expires_at)
                 VALUES ('${id}', '${query.replace(/'/g, "''")}', '${cacheKey.replace(/'/g, "''")}', '${provider}', '${resultsJson.replace(/'/g, "''")}', '${expiresAt}')`;
    
    conn.exec(sql, (err) => {
      if (err) {
        console.error('Failed to cache result:', err);
        console.error('SQL:', sql.substring(0, 200));
        reject(err);
        return;
      }

      // Clean up expired entries
      conn.exec(
        `DELETE FROM search_cache WHERE expires_at < '${now.toISOString()}'`,
        (cleanupErr) => {
          if (cleanupErr) {
            console.error('Failed to cleanup expired cache:', cleanupErr);
          }
          resolve();
        }
      );
    });
  });
}

export async function deleteCachedResult(cacheKey) {
  if (!CACHE_ENABLED) return;
  return new Promise((resolve) => {
    const conn = getConnection();
    conn.exec(
      `DELETE FROM search_cache WHERE normalized_query = '${cacheKey.replace(/'/g, "''")}'`,
      () => resolve()
    );
  });
}

export async function getCacheStats() {
  return new Promise((resolve, reject) => {
    const conn = getConnection();
    const now = new Date().toISOString();

    conn.all(
      `SELECT 
        COUNT(*) as total_entries,
        SUM(hit_count) as total_hits,
        AVG(hit_count) as avg_hits,
        COUNT(CASE WHEN expires_at > '${now}' THEN 1 END) as active_entries
       FROM search_cache`,
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        const stats = rows[0] || {};
        const totalHits = Number(stats.total_hits) || 0;
        const totalEntries = Number(stats.total_entries) || 0;
        const hitRate = totalHits > 0 
          ? (totalHits / (totalHits + totalEntries)) 
          : 0;

        resolve({
          enabled: CACHE_ENABLED,
          size: Number(stats.active_entries) || 0,
          totalEntries: totalEntries,
          totalHits: totalHits,
          hitRate: Number.isFinite(hitRate) ? parseFloat(hitRate.toFixed(2)) : 0
        });
      }
    );
  });
}
