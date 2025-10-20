import duckdb from 'duckdb';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DB_PATH || './data/web_search.duckdb';
const dataDir = dirname(join(process.cwd(), DB_PATH));

// Ensure data directory exists
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

export function initializeDatabase() {
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Failed to create database:', err);
        reject(err);
        return;
      }

      console.log(`Database initialized at: ${DB_PATH}`);

      // Create tables
      const connection = db.connect();

      connection.exec(`
        -- Search cache table
        CREATE TABLE IF NOT EXISTS search_cache (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          normalized_query TEXT NOT NULL,
          provider TEXT NOT NULL,
          results TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          expires_at TIMESTAMP NOT NULL,
          hit_count INTEGER DEFAULT 0,
          last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_search_cache_normalized_query 
        ON search_cache(normalized_query);
        
        CREATE INDEX IF NOT EXISTS idx_search_cache_expires_at 
        ON search_cache(expires_at);
        
        CREATE INDEX IF NOT EXISTS idx_search_cache_provider 
        ON search_cache(provider);

        -- Search history table
        CREATE TABLE IF NOT EXISTS search_history (
          id TEXT PRIMARY KEY,
          query TEXT NOT NULL,
          provider TEXT NOT NULL,
          results_count INTEGER,
          cached BOOLEAN DEFAULT FALSE,
          elapsed_ms INTEGER,
          user_id TEXT,
          session_id TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_search_history_user_id 
        ON search_history(user_id);
        
        CREATE INDEX IF NOT EXISTS idx_search_history_created_at 
        ON search_history(created_at);
      `, (err) => {
        if (err) {
          console.error('Failed to create tables:', err);
          reject(err);
          return;
        }

        console.log('Database tables created successfully');
        db.close();
        resolve();
      });
    });
  });
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  initializeDatabase()
    .then(() => {
      console.log('Database initialization complete');
      process.exit(0);
    })
    .catch((err) => {
      console.error('Database initialization failed:', err);
      process.exit(1);
    });
}
