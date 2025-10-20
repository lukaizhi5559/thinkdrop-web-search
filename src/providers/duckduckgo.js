import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const DUCKDUCKGO_BASE_URL = process.env.DUCKDUCKGO_BASE_URL || 'https://api.duckduckgo.com';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 5000;

export async function searchDuckDuckGo(query, options = {}) {
  const startTime = Date.now();

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    no_html: 1,
    skip_disambig: 1
  });

  const url = `${DUCKDUCKGO_BASE_URL}/?${params.toString()}`;

  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'ThinkdropAI/1.0'
      }
    });

    const elapsedMs = Date.now() - startTime;
    const results = [];

    // Parse instant answer
    if (response.data.AbstractText) {
      results.push({
        title: response.data.Heading || 'Instant Answer',
        description: response.data.AbstractText,
        url: response.data.AbstractURL,
        source: 'DuckDuckGo',
        type: 'instant-answer',
        relevanceScore: 0.95
      });
    }

    // Parse related topics
    if (response.data.RelatedTopics) {
      response.data.RelatedTopics.forEach(topic => {
        if (topic.Text && topic.FirstURL) {
          const titleMatch = topic.Text.split(' - ');
          results.push({
            title: titleMatch[0] || topic.Text,
            description: topic.Text,
            url: topic.FirstURL,
            source: 'DuckDuckGo',
            type: 'related-topic',
            relevanceScore: 0.7
          });
        }
      });
    }

    // Limit results
    const maxResults = options.maxResults || 10;
    const limitedResults = results.slice(0, maxResults);

    return {
      results: limitedResults,
      total: limitedResults.length,
      provider: 'duckduckgo',
      elapsedMs
    };
  } catch (error) {
    throw new Error(`DuckDuckGo search failed: ${error.message}`);
  }
}
