import axios from 'axios';
import dotenv from 'dotenv';
import { downloadImage, getCachePath, isCached, ensureCacheDir, cleanupOldImages } from '../utils/imageCache.js';

dotenv.config();

// Initialize cache on module load
ensureCacheDir().catch(console.error);
// Clean up old images periodically (every hour) - singleton guard prevents duplicate timers
if (!global.__imageCacheCleanupInterval) {
  global.__imageCacheCleanupInterval = setInterval(() => cleanupOldImages().catch(console.error), 60 * 60 * 1000);
}

const BRAVE_API_KEY = process.env.BRAVE_API_WEB_KEY; // Using web key for all endpoints
const BASE_URL = 'https://api.search.brave.com/res/v1';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 10000;
const IMAGE_VALIDATION_TIMEOUT = 5000; // 5s timeout for image validation

/**
 * Validate image URL accessibility
 * Returns true if URL is accessible, false otherwise
 */
async function validateImageUrl(url) {
  if (!url || !url.startsWith('http')) return false;
  
  try {
    const response = await axios.head(url, {
      timeout: IMAGE_VALIDATION_TIMEOUT,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      // Don't throw on 4xx/5xx - we just want to check if it's reachable
      validateStatus: () => true
    });
    
    // Accept 200-299 status codes
    // Reject 400, 401, 403, 404, etc.
    if (response.status >= 200 && response.status < 300) {
      // Also check content-type if available
      const contentType = response.headers['content-type'] || '';
      if (contentType && !contentType.includes('image') && !contentType.includes('octet-stream')) {
        return false;
      }
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * Filter image results to only include accessible URLs
 * Validates URLs in parallel for efficiency
 */
async function filterAccessibleImages(images, maxResults = 10) {
  if (!images || images.length === 0) return [];
  
  const validatedImages = [];
  
  // Process in batches to avoid overwhelming the network
  const batchSize = 3;
  for (let i = 0; i < images.length && validatedImages.length < maxResults; i += batchSize) {
    const batch = images.slice(i, i + batchSize);
    
    // Validate batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (image) => {
        const imageUrl = image.properties?.url;
        const thumbnailUrl = image.thumbnail?.src;
        
        // Try main image URL first
        if (imageUrl && await validateImageUrl(imageUrl)) {
          return { ...image, validatedUrl: imageUrl, isValid: true };
        }
        
        // Fall back to thumbnail if main fails
        if (thumbnailUrl && await validateImageUrl(thumbnailUrl)) {
          return { ...image, validatedUrl: thumbnailUrl, isValid: true };
        }
        
        return { ...image, isValid: false };
      })
    );
    
    // Add valid images to results
    for (const result of batchResults) {
      if (result.isValid && validatedImages.length < maxResults) {
        validatedImages.push(result);
      }
    }
  }
  
  return validatedImages;
}

/**
 * Brave Web Search API (traditional search results)
 */
export async function searchBraveWeb(query, options = {}) {
  const startTime = Date.now();

  if (!BRAVE_API_KEY) {
    throw new Error('BRAVE_API_WEB_KEY is not configured');
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: options.maxResults || 10
    });

    // Optional parameters
    if (options.country) params.append('country', options.country);
    if (options.search_lang) params.append('search_lang', options.search_lang);
    if (options.safesearch) params.append('safesearch', options.safesearch);

    const response = await axios.get(
      `${BASE_URL}/web/search?${params.toString()}`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY
        }
      }
    );

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse web results
    if (response.data.web && response.data.web.results) {
      response.data.web.results.forEach((result, idx) => {
        results.push({
          title: result.title || '',
          description: result.description || '',
          url: result.url || '',
          source: 'Brave Search',
          type: 'web-result',
          relevanceScore: 0.9 - (idx * 0.05),
          metadata: {
            age: result.age,
            language: result.language,
            family_friendly: result.family_friendly
          }
        });
      });
    }

    return {
      results,
      total: results.length,
      provider: 'brave-web',
      elapsedMs
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Brave Web search failed: ${error.response.status} - ${error.response.data?.message || error.message}`);
    }
    throw new Error(`Brave Web search failed: ${error.message}`);
  }
}

/**
 * Brave Rich Search API (structured data: prices, weather, calculations)
 */
export async function searchBraveRich(query, options = {}) {
  const startTime = Date.now();

  if (!BRAVE_API_KEY) {
    throw new Error('BRAVE_API_WEB_KEY is not configured');
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: options.maxResults || 10
    });

    const response = await axios.get(
      `${BASE_URL}/web/search?${params.toString()}`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY
        }
      }
    );

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse infobox (rich results)
    if (response.data.infobox) {
      const infobox = response.data.infobox;
      results.push({
        title: infobox.title || 'Rich Result',
        description: infobox.description || '',
        url: infobox.url || '',
        source: 'Brave Rich Search',
        type: 'rich-result',
        relevanceScore: 1.0,
        metadata: {
          category: infobox.category,
          data: infobox.data || {}
        }
      });
    }

    // Parse graph results (prices, stocks, etc.)
    if (response.data.graph) {
      const graph = response.data.graph;
      results.push({
        title: graph.title || 'Graph Data',
        description: graph.description || '',
        url: graph.url || '',
        source: 'Brave Rich Search',
        type: 'graph-result',
        relevanceScore: 0.95,
        metadata: {
          type: graph.type,
          data: graph.data || {}
        }
      });
    }

    // Parse location results (weather, places)
    if (response.data.locations && response.data.locations.results) {
      response.data.locations.results.forEach((location, idx) => {
        results.push({
          title: location.title || '',
          description: location.description || '',
          url: location.url || '',
          source: 'Brave Rich Search',
          type: 'location-result',
          relevanceScore: 0.9 - (idx * 0.05),
          metadata: {
            coordinates: location.coordinates,
            address: location.address
          }
        });
      });
    }

    // Fallback to web results if no rich results
    if (results.length === 0 && response.data.web && response.data.web.results) {
      response.data.web.results.slice(0, 3).forEach((result, idx) => {
        results.push({
          title: result.title || '',
          description: result.description || '',
          url: result.url || '',
          source: 'Brave Search',
          type: 'web-result',
          relevanceScore: 0.8 - (idx * 0.05)
        });
      });
    }

    return {
      results,
      total: results.length,
      provider: 'brave-rich',
      elapsedMs,
      metadata: {
        hasRichResults: results.some(r => r.type.includes('rich') || r.type.includes('graph'))
      }
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Brave Rich search failed: ${error.response.status} - ${error.response.data?.message || error.message}`);
    }
    throw new Error(`Brave Rich search failed: ${error.message}`);
  }
}

/**
 * Brave News Search API
 */
export async function searchBraveNews(query, options = {}) {
  const startTime = Date.now();

  if (!BRAVE_API_KEY) {
    throw new Error('BRAVE_API_WEB_KEY is not configured');
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: options.maxResults || 10,
      freshness: options.freshness || 'pd' // Past day by default
    });

    if (options.country) params.append('country', options.country);

    const response = await axios.get(
      `${BASE_URL}/news/search?${params.toString()}`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY
        }
      }
    );

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse news results
    if (response.data.results) {
      response.data.results.forEach((article, idx) => {
        results.push({
          title: article.title || '',
          description: article.description || article.snippet || '',
          url: article.url || '',
          source: article.source?.name || 'News Source',
          type: 'news-article',
          relevanceScore: 0.95 - (idx * 0.03),
          metadata: {
            published_date: article.published_date || article.age,
            thumbnail: article.thumbnail,
            breaking: article.breaking || false
          }
        });
      });
    }

    return {
      results,
      total: results.length,
      provider: 'brave-news',
      elapsedMs
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Brave News search failed: ${error.response.status} - ${error.response.data?.message || error.message}`);
    }
    throw new Error(`Brave News search failed: ${error.message}`);
  }
}

/**
 * Brave Video Search API
 */
export async function searchBraveVideo(query, options = {}) {
  const startTime = Date.now();

  if (!BRAVE_API_KEY) {
    throw new Error('BRAVE_API_WEB_KEY is not configured');
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: options.maxResults || 10
    });

    if (options.country) params.append('country', options.country);

    const response = await axios.get(
      `${BASE_URL}/videos/search?${params.toString()}`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY
        }
      }
    );

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse video results
    if (response.data.results) {
      response.data.results.forEach((video, idx) => {
        results.push({
          title: video.title || '',
          description: video.description || '',
          url: video.url || '',
          source: video.source || 'Video Source',
          type: 'video-result',
          relevanceScore: 0.95 - (idx * 0.03),
          metadata: {
            thumbnail: video.thumbnail,
            duration: video.duration,
            views: video.views,
            published_date: video.published_date || video.age,
            channel: video.channel
          }
        });
      });
    }

    return {
      results,
      total: results.length,
      provider: 'brave-video',
      elapsedMs
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Brave Video search failed: ${error.response.status} - ${error.response.data?.message || error.message}`);
    }
    throw new Error(`Brave Video search failed: ${error.message}`);
  }
}

/**
 * Brave Image Search API
 */
export async function searchBraveImage(query, options = {}) {
  const startTime = Date.now();

  if (!BRAVE_API_KEY) {
    throw new Error('BRAVE_API_WEB_KEY is not configured');
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: options.maxResults || 10
    });

    if (options.country) params.append('country', options.country);
    if (options.safesearch) params.append('safesearch', options.safesearch);

    const response = await axios.get(
      `${BASE_URL}/images/search?${params.toString()}`,
      {
        timeout: REQUEST_TIMEOUT,
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': BRAVE_API_KEY
        }
      }
    );

    const elapsedMs = Date.now() - startTime;
    const rawResults = [];

    // Parse image results from API
    if (response.data.results) {
      response.data.results.forEach((image, idx) => {
        rawResults.push({
          title: image.title || '',
          description: image.description || '',
          url: image.url || '',
          source: image.source || 'Image Source',
          type: 'image-result',
          relevanceScore: 0.95 - (idx * 0.03),
          thumbnail: image.thumbnail,
          properties: {
            url: image.properties?.url,
            width: image.properties?.width,
            height: image.properties?.height,
            format: image.properties?.format
          }
        });
      });
    }

    // Filter to only accessible images before downloading
    const accessibleResults = await filterAccessibleImages(rawResults, options.maxResults || 10);

    // Download images to local cache and serve from there
    // This avoids hotlinking issues with Getty, Pinterest, etc.
    const results = await Promise.all(
      accessibleResults.map(async (image) => {
        // Try multiple sources for the image
        const thumbnailUrl = image.thumbnail?.src;
        const originalUrl = image.properties?.url;
        const pageUrl = image.url;
        
        // Try to download: thumbnail first, then original
        let cachedFilename = null;
        let sourceUrl = null;
        
        // Try thumbnail
        if (thumbnailUrl) {
          cachedFilename = await downloadImage(thumbnailUrl);
          if (cachedFilename) {
            sourceUrl = thumbnailUrl;
          }
        }
        
        // Fallback to original URL
        if (!cachedFilename && originalUrl) {
          cachedFilename = await downloadImage(originalUrl);
          if (cachedFilename) {
            sourceUrl = originalUrl;
          }
        }
        
        // Build local URL if we have a cached file
        // Use custom protocol for reliable local image serving
        const localUrl = cachedFilename 
          ? `thinkdrop-image://${cachedFilename}`
          : null;
        
        return {
          title: image.title,
          description: image.description,
          // Keep original page URL for context
          url: pageUrl,
          source: image.source,
          type: 'image-result',
          relevanceScore: image.relevanceScore,
          metadata: {
            thumbnail: image.thumbnail,
            properties: {
              // Use local URL as primary - always loads reliably
              url: localUrl || thumbnailUrl || originalUrl,
              // Store original for reference/click-to-view
              originalUrl: originalUrl,
              // Store if we have a cached version
              cached: !!cachedFilename,
              cachedFilename: cachedFilename,
              width: image.properties?.width,
              height: image.properties?.height,
              format: image.properties?.format
            }
          }
        };
      })
    );

    const cachedCount = results.filter(r => r.metadata.properties.cached).length;
    console.log(`[BraveImage] Downloaded ${cachedCount}/${results.length} images to cache`);

    return {
      results,
      total: results.length,
      provider: 'brave-image',
      elapsedMs
    };
  } catch (error) {
    if (error.response) {
      throw new Error(`Brave Image search failed: ${error.response.status} - ${error.response.data?.message || error.message}`);
    }
    throw new Error(`Brave Image search failed: ${error.message}`);
  }
}
