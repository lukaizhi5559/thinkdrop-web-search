import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import os from 'os';

const CACHE_DIR = process.env.IMAGE_CACHE_DIR || path.join(os.homedir(), '.thinkdrop', 'image-cache');
const MAX_CACHE_AGE_MS = (process.env.IMAGE_CACHE_MAX_AGE_DAYS || 7) * 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE_BYTES = (process.env.IMAGE_CACHE_MAX_SIZE_MB || 100) * 1024 * 1024;

/**
 * Ensure cache directory exists
 */
async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('[ImageCache] Failed to create cache directory:', error);
    throw error;
  }
}

/**
 * Generate cache filename from URL
 */
function generateCacheFilename(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  const timestamp = Date.now();
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  return `${hash}_${timestamp}${ext}`;
}

/**
 * Download image from URL to cache
 * @returns {Promise<string|null>} Local filename or null if failed
 */
async function downloadImage(url) {
  if (!url || !url.startsWith('http')) {
    return null;
  }

  const filename = generateCacheFilename(url);
  const filepath = path.join(CACHE_DIR, filename);

  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    
    const request = client.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    }, (response) => {
      if (response.statusCode !== 200) {
        console.warn(`[ImageCache] Failed to download ${url}: ${response.statusCode}`);
        resolve(null);
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', async () => {
        try {
          const buffer = Buffer.concat(chunks);
          
          // Validate it's actually an image
          const isImage = buffer.slice(0, 4).toString('hex').match(/^(ffd8ff|89504e47|47494638)/);
          if (!isImage && buffer.length > 0) {
            console.warn(`[ImageCache] Downloaded file is not an image: ${url}`);
            resolve(null);
            return;
          }

          await fs.writeFile(filepath, buffer);
          console.log(`[ImageCache] Downloaded ${url} → ${filename} (${buffer.length} bytes)`);
          resolve(filename);
        } catch (error) {
          console.error(`[ImageCache] Failed to save ${url}:`, error);
          resolve(null);
        }
      });
    });

    request.on('error', (error) => {
      console.warn(`[ImageCache] Download error for ${url}:`, error.message);
      resolve(null);
    });

    request.on('timeout', () => {
      console.warn(`[ImageCache] Download timeout for ${url}`);
      request.destroy();
      resolve(null);
    });
  });
}

/**
 * Get full path to cached file
 */
function getCachePath(filename) {
  return path.join(CACHE_DIR, filename);
}

/**
 * Check if file exists in cache
 */
async function isCached(filename) {
  try {
    await fs.access(path.join(CACHE_DIR, filename));
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up old images from cache
 */
async function cleanupOldImages() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    const now = Date.now();
    let deletedCount = 0;
    let freedBytes = 0;

    for (const file of files) {
      const filepath = path.join(CACHE_DIR, file);
      try {
        const stats = await fs.stat(filepath);
        const age = now - stats.mtime.getTime();
        
        if (age > MAX_CACHE_AGE_MS) {
          await fs.unlink(filepath);
          deletedCount++;
          freedBytes += stats.size;
        }
      } catch (error) {
        console.warn(`[ImageCache] Failed to stat/delete ${file}:`, error);
      }
    }

    if (deletedCount > 0) {
      console.log(`[ImageCache] Cleaned up ${deletedCount} old files, freed ${Math.round(freedBytes / 1024 / 1024)}MB`);
    }
  } catch (error) {
    console.error('[ImageCache] Cleanup error:', error);
  }
}

/**
 * Get cache statistics
 */
async function getCacheStats() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    let totalSize = 0;
    let fileCount = 0;

    for (const file of files) {
      try {
        const stats = await fs.stat(path.join(CACHE_DIR, file));
        totalSize += stats.size;
        fileCount++;
      } catch {}
    }

    return {
      fileCount,
      totalSizeBytes: totalSize,
      totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
      maxSizeMB: MAX_CACHE_SIZE_BYTES / 1024 / 1024,
      cacheDir: CACHE_DIR
    };
  } catch (error) {
    return { error: error.message };
  }
}

export {
  ensureCacheDir,
  downloadImage,
  getCachePath,
  isCached,
  cleanupOldImages,
  getCacheStats,
  CACHE_DIR
};
