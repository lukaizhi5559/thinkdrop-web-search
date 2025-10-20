import { normalizeQuery, getCacheTTL } from '../../src/services/cache.js';

describe('Cache Service', () => {
  describe('normalizeQuery', () => {
    test('should normalize query to lowercase', () => {
      expect(normalizeQuery('HELLO WORLD')).toContain('hello world');
    });

    test('should trim whitespace', () => {
      expect(normalizeQuery('  hello  ')).toContain('hello');
    });

    test('should replace multiple spaces with single space', () => {
      expect(normalizeQuery('hello    world')).toContain('hello world');
    });

    test('should include params in cache key', () => {
      const result = normalizeQuery('test', { maxResults: 10 });
      expect(result).toContain('test');
      expect(result).toContain('maxResults');
    });
  });

  describe('getCacheTTL', () => {
    test('should return short TTL for time-sensitive queries', () => {
      const ttl = getCacheTTL('latest news');
      expect(ttl).toBeLessThan(86400000); // Less than 24 hours
    });

    test('should return long TTL for general queries', () => {
      const ttl = getCacheTTL('history of rome');
      expect(ttl).toBeGreaterThan(600000); // More than 10 minutes
    });

    test('should detect breaking news as time-sensitive', () => {
      const ttl = getCacheTTL('breaking news today');
      expect(ttl).toBeLessThan(86400000);
    });
  });
});
