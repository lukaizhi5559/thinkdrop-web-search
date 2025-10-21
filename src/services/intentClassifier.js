/**
 * Smart Query Intent Classification
 * Routes queries to the appropriate Brave Search API endpoint
 */

// Comprehensive keyword and pattern matching for intent classification
const QUERY_PATTERNS = {
  // Rich Search - Real-time data, prices, calculations, structured data
  rich: {
    keywords: [
      // Cryptocurrency
      'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'cryptocurrency', 'dogecoin', 
      'litecoin', 'ripple', 'xrp', 'cardano', 'ada', 'solana', 'sol', 'polygon', 'matic',
      
      // Stock market
      'stock', 'stocks', 'share', 'shares', 'nasdaq', 'dow', 's&p', 'market cap',
      'ticker', 'trading', 'dividend', 'portfolio',
      
      // Currency & Finance
      'currency', 'exchange rate', 'forex', 'usd', 'eur', 'gbp', 'jpy', 'cad', 'aud',
      'dollar', 'euro', 'pound', 'yen', 'conversion', 'convert',
      
      // Weather
      'weather', 'temperature', 'forecast', 'rain', 'snow', 'sunny', 'cloudy',
      'humidity', 'wind', 'storm', 'hurricane', 'celsius', 'fahrenheit',
      
      // Calculations & Conversions
      'calculator', 'calculate', 'compute', 'convert', 'conversion', 'unit',
      'miles to km', 'kg to lbs', 'feet to meters', 'gallons to liters',
      
      // Time & Date
      'time', 'timezone', 'current time', 'time in', 'date', 'calendar',
      
      // Sports scores (real-time)
      'score', 'game', 'match', 'live score', 'standings', 'league table',
      
      // Prices & Values
      'price', 'cost', 'value', 'worth', 'how much', 'pricing', 'rate'
    ],
    
    patterns: [
      // Price queries
      /what(?:'s| is) (?:the )?(?:current |latest |today's )?price/i,
      /how much (?:is|does|do|are|cost|costs)/i,
      /price of/i,
      /cost of/i,
      
      // Crypto specific
      /(?:bitcoin|btc|ethereum|eth|crypto|cryptocurrency|dogecoin|doge|solana|sol|cardano|ada) (?:price|value|worth|cost)/i,
      /(?:btc|eth|doge|sol|ada|xrp)\/(?:usd|eur|gbp)/i,
      
      // Stock queries
      /(?:stock|share) price/i,
      /(?:nasdaq|dow|s&p|nyse) (?:today|now|current)/i,
      /ticker (?:symbol )?[A-Z]{1,5}/i,
      
      // Weather queries
      /weather (?:in|at|for)/i,
      /(?:temperature|forecast) (?:in|at|for)/i,
      /(?:will it|is it going to) (?:rain|snow)/i,
      
      // Currency conversion
      /convert \d+/i,
      /\d+ (?:usd|eur|gbp|jpy|cad|aud) to (?:usd|eur|gbp|jpy|cad|aud)/i,
      /exchange rate/i,
      
      // Calculations
      /calculate/i,
      /\d+ (?:\+|\-|\*|\/|plus|minus|times|divided by) \d+/i,
      
      // Time queries
      /what time is it in/i,
      /current time in/i,
      /time zone/i,
      
      // Sports scores
      /(?:live )?(?:score|game|match) (?:of|for|between)/i,
      /who(?:'s| is) winning/i
    ],
    
    verticals: ['cryptocurrency', 'currency', 'weather', 'calculator', 'stocks', 
                'unit_converter', 'time', 'sports']
  },
  
  // News Search - Current events, breaking news, recent updates
  news: {
    keywords: [
      // News terms
      'news', 'breaking', 'latest', 'recent', 'update', 'updates', 'headline', 'headlines',
      'report', 'reported', 'reporting', 'announcement', 'announced', 'breaking news',
      
      // Time-based
      'today', 'yesterday', 'this week', 'this month', 'currently', 'now', 'just now',
      'moments ago', 'hours ago', 'days ago',
      
      // Events
      'happened', 'happening', 'occurred', 'event', 'incident', 'situation',
      'development', 'story', 'coverage',
      
      // News sources
      'according to', 'sources say', 'reports indicate', 'confirmed',
      
      // Current affairs
      'election', 'politics', 'government', 'president', 'congress', 'senate',
      'conflict', 'war', 'peace', 'treaty', 'agreement', 'scandal', 'controversy'
    ],
    
    patterns: [
      /(?:latest|breaking|recent) news/i,
      /news (?:about|on|regarding)/i,
      /what happened/i,
      /what's happening/i,
      /(?:today's|yesterday's|this week's) (?:news|headlines|top stories)/i,
      /breaking:/i,
      /just (?:announced|reported|confirmed)/i,
      /(?:recent|latest) (?:update|development|event)/i,
      /(?:election|vote|voting) (?:results|news|update)/i,
      /(?:war|conflict|crisis) in/i
    ]
  },
  
  // Video Search - Movies, shows, tutorials, entertainment
  video: {
    keywords: [
      // Video platforms
      'video', 'youtube', 'vimeo', 'tiktok', 'instagram reels', 'shorts',
      
      // Movies & Shows
      'movie', 'movies', 'film', 'films', 'cinema', 'theater', 'theatre',
      'show', 'series', 'tv show', 'television', 'episode', 'season',
      'documentary', 'docuseries',
      
      // Streaming
      'watch', 'stream', 'streaming', 'netflix', 'hulu', 'disney+', 'disney plus',
      'amazon prime', 'hbo', 'hbo max', 'apple tv', 'paramount+',
      
      // Video content
      'trailer', 'teaser', 'clip', 'scene', 'preview', 'promo',
      'review', 'reaction', 'analysis', 'breakdown',
      
      // Tutorials
      'tutorial', 'how to', 'guide', 'walkthrough', 'demonstration', 'demo',
      'lesson', 'course', 'learn', 'learning',
      
      // Entertainment
      'comedy', 'funny', 'hilarious', 'sketch', 'standup', 'stand-up',
      'music video', 'concert', 'performance', 'live performance',
      
      // Studios & Franchises
      'disney', 'pixar', 'marvel', 'dc', 'warner bros', 'universal',
      'star wars', 'harry potter', 'lord of the rings'
    ],
    
    patterns: [
      /(?:watch|stream|find) (?:the )?(?:movie|film|video|show|series)/i,
      /(?:movie|film) (?:trailer|review|clip|scene)/i,
      /how to .+(?:video|tutorial)/i,
      /(?:disney|marvel|dc|netflix|hulu) (?:movie|show|series)/i,
      /(?:latest|new|upcoming) (?:movie|film|show|series)/i,
      /(?:best|top) (?:\d+ )?(?:movies|films|shows|series)/i,
      /(?:full )?(?:movie|episode|season) (?:online|free|hd)/i,
      /(?:youtube|vimeo|tiktok) video/i,
      /music video (?:of|for|by)/i,
      /(?:funny|comedy|hilarious) (?:video|clip)/i,
      /tutorial (?:on|for|about)/i
    ]
  },
  
  // Image Search - Pictures, photos, visual content
  image: {
    keywords: [
      // Image types
      'image', 'images', 'picture', 'pictures', 'photo', 'photos', 'photograph',
      'pic', 'pics', 'snapshot', 'shot',
      
      // Visual content
      'logo', 'icon', 'symbol', 'emblem', 'badge', 'avatar',
      'wallpaper', 'background', 'backdrop', 'banner', 'header',
      'screenshot', 'screen capture', 'screengrab',
      
      // Graphics
      'graphic', 'illustration', 'drawing', 'artwork', 'art',
      'diagram', 'chart', 'graph', 'infographic', 'visualization',
      'map', 'blueprint', 'sketch', 'design',
      
      // Visual queries
      'look like', 'looks like', 'appearance', 'visual', 'visually',
      'show me', 'display', 'view', 'see',
      
      // Image search specific
      'gallery', 'album', 'collection', 'portfolio',
      'high resolution', 'hd', '4k', 'quality',
      'thumbnail', 'preview'
    ],
    
    patterns: [
      /(?:show|find|get|search) (?:me )?(?:images?|pictures?|photos?)/i,
      /(?:images?|pictures?|photos?) of/i,
      /what does .+ look like/i,
      /(?:logo|icon|symbol) (?:of|for)/i,
      /picture of/i,
      /(?:wallpaper|background) (?:for|of)/i,
      /(?:diagram|chart|graph|infographic) (?:of|for|showing)/i,
      /(?:screenshot|screen capture) of/i,
      /(?:high resolution|hd|4k) (?:image|picture|photo)/i,
      /(?:gallery|album|collection) of/i
    ]
  },
  
  // Web Search - General information queries (default fallback)
  web: {
    keywords: [
      // Question words
      'what', 'who', 'where', 'when', 'why', 'how', 'which', 'whose',
      
      // Information seeking
      'define', 'definition', 'meaning', 'explain', 'explanation',
      'describe', 'description', 'tell me', 'information', 'info',
      'about', 'regarding', 'concerning',
      
      // Learning
      'learn', 'understand', 'know', 'find out', 'discover',
      
      // Comparison
      'compare', 'comparison', 'difference', 'versus', 'vs',
      'better', 'best', 'worst', 'pros and cons',
      
      // Lists
      'list', 'examples', 'types', 'kinds', 'categories'
    ],
    
    patterns: [
      /^(?:what|who|where|when|why|how|which)/i,
      /(?:define|definition of|meaning of)/i,
      /(?:explain|describe|tell me about)/i,
      /(?:how (?:do|does|did|can|could|would|should))/i,
      /(?:what (?:is|are|was|were))/i,
      /(?:who (?:is|are|was|were))/i,
      /(?:difference between|compare)/i,
      /(?:best|top|worst) .+(?:for|to)/i,
      /(?:list of|examples of)/i,
      /.*/  // Catch-all for general queries
    ]
  }
};

/**
 * Classify query intent using keyword and pattern matching
 * @param {string} query - The search query
 * @returns {string} - The detected intent (rich, news, video, image, web)
 */
export function classifyQueryIntent(query) {
  const scores = {
    rich: 0,
    news: 0,
    video: 0,
    image: 0,
    web: 0
  };
  
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);
  
  // Score based on keywords
  for (const [intent, config] of Object.entries(QUERY_PATTERNS)) {
    // Keyword matching (weight: 2 points each)
    // Use word boundary matching for better accuracy
    config.keywords?.forEach(keyword => {
      const keywordLower = keyword.toLowerCase();
      
      // Exact phrase match (higher weight)
      if (queryLower.includes(keywordLower)) {
        scores[intent] += 2;
      }
      
      // Individual word match (lower weight)
      const keywordWords = keywordLower.split(/\s+/);
      keywordWords.forEach(word => {
        if (queryWords.includes(word)) {
          scores[intent] += 1;
        }
      });
    });
    
    // Pattern matching (weight: 5 points each - strongest signal)
    config.patterns?.forEach(pattern => {
      if (pattern.test(query)) {
        scores[intent] += 5;
      }
    });
  }
  
  // Find highest scoring intent
  const sortedIntents = Object.entries(scores)
    .sort(([, a], [, b]) => b - a);
  
  const topIntent = sortedIntents[0][0];
  const topScore = sortedIntents[0][1];
  const secondScore = sortedIntents[1][1];
  
  // Debug logging
  console.log('🎯 Intent Classification Scores:', scores);
  console.log(`🏆 Top Intent: ${topIntent} (score: ${topScore})`);
  
  // If no strong match or web search has highest score, default to web
  // But if another intent has a strong signal, prefer it over web
  if (topIntent === 'web' && secondScore > 3) {
    const secondIntent = sortedIntents[1][0];
    console.log(`⚠️  Web search scored highest, but ${secondIntent} has strong signal (${secondScore}). Using ${secondIntent}.`);
    return secondIntent;
  }
  
  // If top score is very low, default to web
  if (topScore < 2) {
    console.log('⚠️  All scores very low, defaulting to web search');
    return 'web';
  }
  
  return topIntent;
}

/**
 * Get human-readable explanation of why an intent was chosen
 * @param {string} query - The search query
 * @param {string} intent - The detected intent
 * @returns {string} - Explanation
 */
export function explainIntent(query, intent) {
  const explanations = {
    rich: 'Real-time data query (prices, weather, calculations, or structured data)',
    news: 'Current events or breaking news query',
    video: 'Video content query (movies, shows, or tutorials)',
    image: 'Visual content query (pictures, photos, or graphics)',
    web: 'General information query'
  };
  
  return explanations[intent] || 'Unknown intent';
}

/**
 * Test the classifier with example queries
 */
export function testClassifier() {
  const testQueries = [
    "what's the latest bitcoin price",
    "latest disney movie",
    "breaking news about AI",
    "show me pictures of cats",
    "who invented the telephone",
    "weather in New York",
    "how to make pizza",
    "convert 100 USD to EUR",
    "ethereum price today",
    "what happened in the election",
    "watch avengers endgame",
    "logo of apple",
    "define artificial intelligence",
    "stock price of tesla",
    "funny cat videos",
    "temperature in london",
    "news about climate change"
  ];
  
  console.log('\n🧪 Testing Intent Classifier:\n');
  testQueries.forEach(query => {
    const intent = classifyQueryIntent(query);
    const explanation = explainIntent(query, intent);
    console.log(`Query: "${query}"`);
    console.log(`Intent: ${intent} - ${explanation}\n`);
  });
}
