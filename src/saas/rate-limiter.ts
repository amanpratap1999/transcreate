export class RateLimitExceededError extends Error {
  public retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.name = "RateLimitExceededError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  limit: number;
  windowSeconds: number;
}

export const RATE_LIMIT_RULES: Record<string, RateLimitRule> = {
  auth: { limit: 5, windowSeconds: 60 },        // 5 logins/min per IP/email
  jobs: { limit: 10, windowSeconds: 60 },       // 10 transcreation jobs/min per Org
  uploads: { limit: 20, windowSeconds: 60 },    // 20 document uploads/min per Org
  standard: { limit: 120, windowSeconds: 60 }   // 120 general requests/min per IP
};

import { Redis } from "ioredis";

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private redis?: Redis;

  constructor() {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("FATAL: REDIS_URL is required for RateLimiter in non-test environments.");
      }
    } else {
      this.redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    }
  }

  /**
   * Evaluates rate limit for a client key using sliding window algorithm.
   */
  public async checkLimit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;

    if (this.redis) {
      // Redis Pipeline for sliding window rate limit
      const pipeline = this.redis.pipeline();
      // Remove hits older than the window
      pipeline.zremrangebyscore(`ratelimit:${key}`, 0, windowStart);
      // Count remaining hits
      pipeline.zcard(`ratelimit:${key}`);
      // Add current hit
      pipeline.zadd(`ratelimit:${key}`, now, `${now}-${Math.random()}`);
      // Set expiry on the set to clean up idle keys
      pipeline.expire(`ratelimit:${key}`, rule.windowSeconds);
      
      const results = await pipeline.exec();
      if (!results) throw new Error("Redis pipeline failed");
      
      const count = results[1][1] as number; // result of zcard
      if (count >= rule.limit) {
        // We added a hit, but we shouldn't have counted it towards allowing the request.
        // Actually, sliding window usually drops the hit if over limit, but here we just deny.
        const oldestHits = await this.redis.zrange(`ratelimit:${key}`, "0", "0", "WITHSCORES");
        let retryAfterSeconds = rule.windowSeconds;
        if (oldestHits.length >= 2) {
            const oldestTime = parseInt(oldestHits[1], 10);
            retryAfterSeconds = Math.max(1, Math.ceil((oldestTime + rule.windowSeconds * 1000 - now) / 1000));
        }

        return {
          allowed: false,
          limit: rule.limit,
          remaining: 0,
          resetSeconds: retryAfterSeconds,
          retryAfterSeconds
        };
      }

      return {
        allowed: true,
        limit: rule.limit,
        remaining: Math.max(0, rule.limit - count - 1),
        resetSeconds: rule.windowSeconds,
        retryAfterSeconds: 0
      };
    }

    // In-memory fallback
    let timestamps = this.hits.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= rule.limit) {
      const oldest = timestamps[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + rule.windowSeconds * 1000 - now) / 1000));
      this.hits.set(key, timestamps);

      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        resetSeconds: retryAfterSeconds,
        retryAfterSeconds
      };
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);

    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit - timestamps.length,
      resetSeconds: rule.windowSeconds,
      retryAfterSeconds: 0
    };
  }

  /**
   * Throws RateLimitExceededError if limit is exceeded.
   */
  public async assertLimit(key: string, rule: RateLimitRule, resourceName = "API"): Promise<void> {
    const result = await this.checkLimit(key, rule);
    if (!result.allowed) {
      throw new RateLimitExceededError(
        `Rate limit exceeded for ${resourceName}. Try again in ${result.retryAfterSeconds}s.`,
        result.retryAfterSeconds
      );
    }
  }

  public reset(key?: string): void {
    if (key) {
      this.hits.delete(key);
    } else {
      this.hits.clear();
    }
  }
}
