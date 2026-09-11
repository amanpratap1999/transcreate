/**
 * Shared Redis connection strategy (P1 #11).
 *
 * ONE connection factory for the whole process (API/worker), with:
 *  - error handlers (never an unhandled 'error' event crash)
 *  - bounded reconnect + bounded offline command buffering
 *  - health check + readiness semantics
 *  - explicit shutdown
 *
 * Fail-open vs fail-closed policy (documented, enforced by callers):
 *  - Rate limiting  → FAIL CLOSED when Redis is down (denies when the limiter
 *    cannot be evaluated). Security must not silently disable.
 *  - Token revocation → FAIL CLOSED on errors (treat as revoked only if Redis
 *    says so; on Redis ERROR, reject the request — an outage must not make
 *    revoked tokens usable). Verification errors propagate as 401/503.
 *  - BullMQ         → required; Redis down = no job dispatch (queue unavailable,
 *    outbox dispatcher retries; jobs remain durable in PostgreSQL).
 */
import { Redis } from "ioredis";

export interface SharedRedisHandle {
  client: Redis;
  isHealthy(): Promise<boolean>;
  close(): Promise<void>;
}

export interface SharedRedisOptions {
  url: string;
  /** Bounded offline buffering (commands queued while disconnected). */
  maxOfflineQueueLength?: number;
  enableOfflineQueue?: boolean;
  /** Seconds between reconnect attempts (ioredis retryStrategy multiplier). */
  reconnectBaseMs?: number;
  /** Hard cap on reconnect delay growth. */
  reconnectMaxMs?: number;
  name?: string;
  lazyConnect?: boolean;
}

const handles = new Map<string, SharedRedisHandle>();

export function getSharedRedis(options?: SharedRedisOptions): SharedRedisHandle {
  const url = options?.url || process.env.REDIS_URL || "redis://127.0.0.1:6379";
  const name = options?.name || "default";
  const existing = handles.get(name);
  if (existing) return existing;

  const client = new Redis(url, {
    maxRetriesPerRequest: null, // BullMQ requirement
    enableOfflineQueue: options?.enableOfflineQueue ?? true,
    maxOfflineQueueLength: options?.maxOfflineQueueLength ?? 1000, // bounded
    retryStrategy: (times: number) => {
      const base = options?.reconnectBaseMs ?? 200;
      const max = options?.reconnectMaxMs ?? 10_000;
      return Math.min(base * Math.pow(2, Math.min(times, 6)), max);
    },
    commandTimeout: 5_000,
    connectionName: `transcreate:${name}`
  });

  client.on("error", (err: Error) => {
    // Never crash the process; log a compact structured line.
    process.stderr.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        message: "Redis connection error",
        context: { name, code: (err as any)?.code, message: err.message }
      }) + "\n"
    );
  });
  client.on("reconnecting", (ms: number) => {
    process.stdout.write(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "WARN",
        message: "Redis reconnecting",
        context: { name, delayMs: ms }
      }) + "\n"
    );
  });

  const handle: SharedRedisHandle = {
    client,
    async isHealthy() {
      try {
        const pong = await client.ping();
        return pong === "PONG";
      } catch {
        return false;
      }
    },
    async close() {
      await client.quit().catch(() => client.disconnect());
    }
  };

  handles.set(name, handle);
  return handle;
}

/** Closes every shared connection (graceful shutdown). */
export async function closeSharedRedis(): Promise<void> {
  await Promise.all([...handles.values()].map(h => h.close()));
  handles.clear();
}

/**
 * Rate limiter / security subsystems call this when Redis is unavailable:
 * returns a denied-by-default decision.
 */
export function redisUnavailableDeny(subsystem: string): { allowed: false; reason: string } {
  return {
    allowed: false,
    reason: `Redis unavailable: ${subsystem} rate/security check cannot be evaluated — failing closed`
  };
}
