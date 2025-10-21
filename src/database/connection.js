import duckdb from 'duckdb';
import dotenv from 'dotenv';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/web_search.duckdb';

let dbInstance = null;
let connectionInstance = null;

export function getDatabase() {
  if (!dbInstance) {
    dbInstance = new duckdb.Database(DB_PATH);
  }
  return dbInstance;
}

export function getConnection() {
  const db = getDatabase();
  // Always create a new connection for thread safety
  return db.connect();
}

export function closeDatabase() {
  return new Promise((resolve, reject) => {
    if (connectionInstance) {
      connectionInstance = null;
    }
    
    if (dbInstance) {
      dbInstance.close((err) => {
        if (err) {
          reject(err);
        } else {
          dbInstance = null;
          resolve();
        }
      });
    } else {
      resolve();
    }
  });
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Closing database connection...');
  await closeDatabase();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Closing database connection...');
  await closeDatabase();
  process.exit(0);
});
