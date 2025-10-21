import { getConnection } from '../database/connection.js';
import { v4 as uuidv4 } from 'uuid';

const metrics = {
  totalSearches: 0,
  requestCount: 0,
  errorCount: 0,
  totalResponseTime: 0,
  startTime: Date.now()
};

export function incrementRequestCount() {
  metrics.requestCount++;
}

export function incrementSearchCount() {
  metrics.totalSearches++;
}

export function incrementErrorCount() {
  metrics.errorCount++;
}

export function recordResponseTime(ms) {
  metrics.totalResponseTime += ms;
}

export function getMetrics() {
  const uptime = Math.floor((Date.now() - metrics.startTime) / 1000);
  const avgResponseTime = metrics.requestCount > 0 
    ? Math.floor(metrics.totalResponseTime / metrics.requestCount)
    : 0;
  const errorRate = metrics.requestCount > 0
    ? parseFloat((metrics.errorCount / metrics.requestCount).toFixed(3))
    : 0;

  return {
    totalSearches: metrics.totalSearches,
    requestCount: metrics.requestCount,
    errorRate,
    avgResponseTime,
    uptime
  };
}

export async function logSearchHistory(data) {
  return new Promise((resolve, reject) => {
    const conn = getConnection();
    const id = `search_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const safeQuery = (data.query || '').replace(/'/g, "''");
    const safeProvider = (data.provider || 'unknown').replace(/'/g, "''");
    const userId = data.userId ? `'${data.userId.replace(/'/g, "''")}'` : 'NULL';
    const sessionId = data.sessionId ? `'${data.sessionId.replace(/'/g, "''")}'` : 'NULL';

    const sql = `INSERT INTO search_history (id, query, provider, results_count, cached, elapsed_ms, user_id, session_id)
                 VALUES ('${id}', '${safeQuery}', '${safeProvider}', ${data.resultsCount || 0}, ${data.cached ? 1 : 0}, ${data.elapsedMs || 0}, ${userId}, ${sessionId})`;

    conn.exec(sql, (err) => {
      if (err) {
        console.error('Failed to log search history:', err);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}
