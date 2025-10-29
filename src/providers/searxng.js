/**
 * SearXNG Provider
 * Free, privacy-focused meta-search engine
 * Aggregates results from multiple search engines
 * No API key required!
 */

import fetch from 'node-fetch';

// Public SearXNG instances (fallback to multiple for reliability)
const SEARXNG_INSTANCES = [
  'https://searx.be',
  'https://search.sapti.me',
  'https://searx.tiekoetter.com',
  'https://search.bus-hit.me',
  'https://searx.work'
];

/**
 * Search using SearXNG
 * @param {string} query - Search query
 * @param {object} options - Search options
 * @returns {Promise<Array>} Search results
 */
export async function searchSearXNG(query, options = {}) {
  const {
    limit = 10,
    timeout = 5000,
    engines = 'google,bing,duckduckgo' // Use multiple engines
  } = options;

  console.log(`🔍 [SearXNG] Searching across multiple instances...`);

  // Try each instance until one succeeds
  for (const instance of SEARXNG_INSTANCES) {
    try {
      console.log(`  Trying instance: ${instance}`);
      
      const url = `${instance}/search?` + new URLSearchParams({
        q: query,
        format: 'json',
        engines: engines,
        language: 'en',
        safesearch: '0'
      });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'ThinkDrop-AI/1.0'
        }
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        console.warn(`  ⚠️  Instance ${instance} returned ${response.status}`);
        continue;
      }

      const data = await response.json();
      
      if (!data.results || data.results.length === 0) {
        console.warn(`  ⚠️  Instance ${instance} returned no results`);
        continue;
      }

      console.log(`  ✅ Instance ${instance} returned ${data.results.length} results`);
      
      // Format and return results
      const formattedResults = formatSearXNGResults(data, limit);
      
      return {
        results: formattedResults,
        source: 'searxng',
        instance: instance,
        totalResults: data.results.length
      };

    } catch (error) {
      if (error.name === 'AbortError') {
        console.warn(`  ⏱️  Instance ${instance} timed out`);
      } else {
        console.warn(`  ❌ Instance ${instance} failed:`, error.message);
      }
      continue; // Try next instance
    }
  }

  // All instances failed
  throw new Error('All SearXNG instances failed or returned empty results');
}

/**
 * Format SearXNG results to standard format
 * @param {object} data - Raw SearXNG response
 * @param {number} limit - Maximum results to return
 * @returns {Array} Formatted results
 */
function formatSearXNGResults(data, limit) {
  if (!data.results || !Array.isArray(data.results)) {
    return [];
  }

  return data.results
    .slice(0, limit)
    .map(result => ({
      title: result.title || '',
      url: result.url || '',
      snippet: result.content || result.description || '',
      description: result.content || result.description || '',
      engine: result.engine || 'unknown',
      score: result.score || 0,
      publishedDate: result.publishedDate || null
    }))
    .filter(result => result.title && result.url); // Filter out invalid results
}

/**
 * Check if SearXNG instance is available
 * @param {string} instance - Instance URL
 * @returns {Promise<boolean>} True if available
 */
export async function checkSearXNGInstance(instance) {
  try {
    const response = await fetch(`${instance}/search?q=test&format=json`, {
      timeout: 3000
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

export default {
  searchSearXNG,
  checkSearXNGInstance
};
