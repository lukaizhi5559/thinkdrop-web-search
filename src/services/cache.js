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

    conn.all(
      'SELECT * FROM search_cache WHERE normalized_query = ? AND expires_at > ?',
      [cacheKey, now],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        if (rows && rows.length > 0) {
          const cached = rows[0];
          
          // Update hit count
          conn.run(
            'UPDATE search_cache SET hit_count = hit_count + 1, last_accessed = ? WHERE id = ?',
            [now, cached.id],
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

  return new Promise((resolve, reject) => {
    const conn = getConnection();
    const id = `cache_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const expiresAt = new Date(Date.now() + ttl).toISOString();
    const resultsJson = JSON.stringify(data.results);

    conn.run(
      `INSERT INTO search_cache (id, query, normalized_query, provider, results, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, data.query, cacheKey, data.provider, resultsJson, expiresAt],
      (err) => {
        if (err) {
          console.error('Failed to cache result:', err);
          reject(err);
          return;
        }

        // Clean up expired entries
        conn.run(
          'DELETE FROM search_cache WHERE expires_at < ?',
          [new Date().toISOString()],
          (cleanupErr) => {
            if (cleanupErr) {
              console.error('Failed to cleanup expired cache:', cleanupErr);
            }
            resolve();
          }
        );
      }
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
        COUNT(CASE WHEN expires_at > ? THEN 1 END) as active_entries
       FROM search_cache`,
      [now],
      (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        const stats = rows[0] || {};
        const hitRate = stats.total_hits > 0 
          ? (stats.total_hits / (stats.total_hits + stats.total_entries)) 
          : 0;

        resolve({
          enabled: CACHE_ENABLED,
          size: stats.active_entries || 0,
          totalEntries: stats.total_entries || 0,
          totalHits: stats.total_hits || 0,
          hitRate: parseFloat(hitRate.toFixed(2))
        });
      }
    );
  });
}
