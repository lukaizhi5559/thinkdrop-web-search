import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const BRAVE_API_KEY = process.env.BRAVE_API_WEB_KEY; // Using web key for all endpoints
const BASE_URL = 'https://api.search.brave.com/res/v1';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 10000;

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
    const results = [];

    // Parse image results
    if (response.data.results) {
      response.data.results.forEach((image, idx) => {
        results.push({
          title: image.title || '',
          description: image.description || '',
          url: image.url || '',
          source: image.source || 'Image Source',
          type: 'image-result',
          relevanceScore: 0.95 - (idx * 0.03),
          metadata: {
            thumbnail: image.thumbnail,
            properties: {
              url: image.properties?.url,
              width: image.properties?.width,
              height: image.properties?.height,
              format: image.properties?.format
            }
          }
        });
      });
    }

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
