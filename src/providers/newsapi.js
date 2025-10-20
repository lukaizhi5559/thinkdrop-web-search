import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const NEWSAPI_KEY = process.env.NEWSAPI_KEY;
const NEWSAPI_BASE_URL = process.env.NEWSAPI_BASE_URL || 'https://newsapi.org/v2';
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT) || 5000;

export async function searchNewsAPI(query, options = {}) {
  if (!NEWSAPI_KEY) {
    throw new Error('NEWSAPI_KEY is not configured');
  }

  const startTime = Date.now();

  // Build request parameters
  const params = new URLSearchParams({
    q: query,
    apiKey: NEWSAPI_KEY,
    pageSize: options.maxResults || 10,
    language: options.language || 'en',
    sortBy: options.sortBy || 'publishedAt'
  });

  if (options.fromDate) params.append('from', options.fromDate);
  if (options.toDate) params.append('to', options.toDate);
  if (options.category) params.append('category', options.category);
  if (options.sources) params.append('sources', options.sources.join(','));

  const url = `${NEWSAPI_BASE_URL}/everything?${params.toString()}`;

  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'ThinkdropAI/1.0'
      }
    });

    const elapsedMs = Date.now() - startTime;

    // Parse and normalize results
    const articles = response.data.articles.map(article => ({
      title: article.title,
      description: article.description,
      url: article.url,
      source: article.source?.name || 'Unknown',
      author: article.author,
      publishedAt: article.publishedAt,
      urlToImage: article.urlToImage,
      content: article.content,
      relevanceScore: 0.9 // Default high relevance for NewsAPI results
    }));

    return {
      results: articles,
      total: response.data.totalResults || articles.length,
      provider: 'newsapi',
      elapsedMs
    };
  } catch (error) {
    if (error.response) {
      // Handle specific NewsAPI errors
      if (error.response.status === 401) {
        throw new Error('INVALID_API_KEY: NewsAPI key is invalid');
      } else if (error.response.status === 429) {
        throw new Error('RATE_LIMIT_EXCEEDED: NewsAPI rate limit exceeded');
      } else {
        throw new Error(`NewsAPI error: ${error.response.data?.message || error.message}`);
      }
    }
    throw error;
  }
}

export async function searchNews(query, options = {}) {
  const startTime = Date.now();

  const params = new URLSearchParams({
    q: query,
    apiKey: NEWSAPI_KEY,
    pageSize: options.maxResults || 10,
    sortBy: options.sortBy || 'publishedAt'
  });

  if (options.category) params.append('category', options.category);
  if (options.country) params.append('country', options.country || 'us');
  if (options.fromDate) params.append('from', options.fromDate);
  if (options.toDate) params.append('to', options.toDate);

  const url = `${NEWSAPI_BASE_URL}/top-headlines?${params.toString()}`;

  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'User-Agent': 'ThinkdropAI/1.0'
      }
    });

    const elapsedMs = Date.now() - startTime;

    const articles = response.data.articles.map(article => ({
      title: article.title,
      description: article.description,
      url: article.url,
      source: article.source?.name || 'Unknown',
      author: article.author,
      publishedAt: article.publishedAt,
      urlToImage: article.urlToImage,
      content: article.content
    }));

    return {
      articles,
      total: response.data.totalResults || articles.length,
      query,
      cached: false,
      elapsedMs
    };
  } catch (error) {
    if (error.response?.status === 401) {
      throw new Error('INVALID_API_KEY: NewsAPI key is invalid');
    } else if (error.response?.status === 429) {
      throw new Error('RATE_LIMIT_EXCEEDED: NewsAPI rate limit exceeded');
    }
    throw error;
  }
}
