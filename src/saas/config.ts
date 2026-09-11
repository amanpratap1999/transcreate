/**
 * Centralized runtime configuration — the single source of truth for
 * environment-driven adapter selection and production fail-closed semantics.
 *
 * Rules (enforced by tests + startup assertions):
 *   production  → fakes FORBIDDEN. Missing mandatory infra config aborts boot.
 *   development → fakes allowed with a loud warning.
 *   test        → fakes allowed when explicitly injected.
 */
import * as crypto from "node:crypto";

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Known-insecure development constants that must NEVER run in production. */
export const KNOWN_INSECURE_SECRETS = new Set([
  "transcreate_dev_secret_key_change_in_production_32_bytes_min",
  "transcreate_presigned_secret_32_chars_min",
  "secret",
  "changeme",
  "change-me",
  "password",
  "jwt_secret",
  "dev-secret"
]);

export interface RuntimeConfig {
  env: "production" | "development" | "test";
  isProduction: boolean;
  databaseUrl: string | undefined;
  redisUrl: string | undefined;
  s3: {
    bucketName: string | undefined;
    region: string | undefined;
    endpoint: string | undefined;
  };
  jwtSecret: string | undefined;
  llm: {
    /** Configured real provider; "none" when unset. */
    provider: "openai" | "anthropic" | "none";
    apiKey: string | undefined;
    baseUrl: string | undefined;
    model: string;
    timeoutMs: number;
    maxRetries: number;
  };
  /** True only when a real LLM provider is fully configured. */
  llmEnabled: boolean;
  http: {
    port: number;
    host: string;
  };
  worker: {
    concurrency: number;
    maxJobRetries: number;
    stalledTimeoutMs: number;
  };
  devHeadersEnabled: boolean;
}

export interface RuntimeConfigOverrides {
  env?: string;
  databaseUrl?: string;
  redisUrl?: string;
  s3BucketName?: string;
  s3Region?: string;
  s3Endpoint?: string;
  jwtSecret?: string;
  llmProvider?: string;
  llmApiKey?: string;
  llmBaseUrl?: string;
  llmModel?: string;
  httpPort?: string;
  workerConcurrency?: string;
  workerMaxRetries?: string;
}

function env(name: string): string | undefined {
  const v = process.env[name];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

/** Minimum entropy/length bar for the JWT signing secret. */
export function assertSecretStrength(name: string, secret: string | undefined, isProduction: boolean): string | undefined {
  if (!secret) {
    if (isProduction) {
      throw new ConfigurationError(
        `Configuration error: ${name} is required in production. Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
      );
    }
    return undefined;
  }
  if (KNOWN_INSECURE_SECRETS.has(secret)) {
    if (isProduction) {
      throw new ConfigurationError(
        `Configuration error: ${name} is set to a known development default. Production refuses to boot with a public/placeholder secret.`
      );
    }
    return secret;
  }
  // >= 32 bytes worth of secret material (hex/base64/any charset >= 32 chars)
  if (secret.length < 32) {
    if (isProduction) {
      throw new ConfigurationError(
        `Configuration error: ${name} must be at least 32 characters (48 random bytes recommended). Current length: ${secret.length}.`
      );
    }
  }
  return secret;
}

function asEnv(raw: string | undefined): RuntimeConfig["env"] {
  const e = (raw || env("NODE_ENV") || "development").toLowerCase();
  if (e === "production") return "production";
  if (e === "test") return "test";
  return "development";
}

/**
 * Loads and validates configuration. In production, every missing mandatory
 * value throws ConfigurationError — the process must fail closed at startup.
 */
export function loadRuntimeConfig(overrides: RuntimeConfigOverrides = {}): RuntimeConfig {
  const envName = asEnv(overrides.env);
  const isProduction = envName === "production";

  const databaseUrl = overrides.databaseUrl || env("DATABASE_URL");
  const redisUrl = overrides.redisUrl || env("REDIS_URL");
  const s3BucketName = overrides.s3BucketName || env("S3_BUCKET_NAME");
  const s3Region = overrides.s3Region || env("AWS_REGION");
  const s3Endpoint = overrides.s3Endpoint || env("S3_ENDPOINT_URL") || env("AWS_ENDPOINT_URL_S3");
  const jwtSecretRaw = overrides.jwtSecret || env("JWT_SECRET");

  const llmProvider = (overrides.llmProvider || env("LLM_PROVIDER") || "").toLowerCase() as RuntimeConfig["llm"]["provider"];
  const llmApiKey = overrides.llmApiKey || env("LLM_API_KEY") || env("OPENAI_API_KEY");
  const llmBaseUrl = overrides.llmBaseUrl || env("LLM_BASE_URL");
  const llmModel = overrides.llmModel || env("LLM_MODEL") || "gpt-4o-mini";

  const port = parseInt(overrides.httpPort || env("PORT") || "3000", 10);

  const cfg: RuntimeConfig = {
    env: envName,
    isProduction,
    databaseUrl,
    redisUrl,
    s3: { bucketName: s3BucketName, region: s3Endpoint && !s3Region ? "us-east-1" : s3Region, endpoint: s3Endpoint },
    jwtSecret: undefined,
    llm: {
      provider: llmProvider === "anthropic" ? "anthropic" : llmProvider === "openai" ? "openai" : llmProvider ? (llmProvider as any) : "none",
      apiKey: llmApiKey,
      baseUrl: llmBaseUrl,
      model: llmModel,
      timeoutMs: parseInt(env("LLM_TIMEOUT_MS") || "120000", 10),
      maxRetries: parseInt(env("LLM_MAX_RETRIES") || "2", 10)
    },
    http: { port, host: "0.0.0.0" },
    worker: {
      concurrency: parseInt(overrides.workerConcurrency || env("WORKER_CONCURRENCY") || "4", 10),
      maxJobRetries: parseInt(overrides.workerMaxRetries || env("WORKER_MAX_RETRIES") || "3", 10),
      stalledTimeoutMs: parseInt(env("WORKER_STALLED_TIMEOUT_MS") || "300000", 10)
    },
    devHeadersEnabled: isDevHeadersEnabled(envName),
    llmEnabled: false
  };

  cfg.llmEnabled = !!cfg.llm.provider && cfg.llm.provider !== "none" && !!cfg.llm.apiKey && (isProduction ? true : true);

  // ---- PRODUCTION FAIL-CLOSED VALIDATION -------------------------------
  if (isProduction) {
    const missing: string[] = [];
    if (!databaseUrl) missing.push("DATABASE_URL");
    if (!redisUrl) missing.push("REDIS_URL");
    if (!s3BucketName) missing.push("S3_BUCKET_NAME");
    if (!s3Region && !s3Endpoint) missing.push("AWS_REGION (or S3_ENDPOINT_URL)");
    if (!cfg.llmEnabled) missing.push("LLM_PROVIDER + LLM_API_KEY");
    if (missing.length > 0) {
      throw new ConfigurationError(
        `Production configuration error: missing mandatory configuration: ${missing.join(", ")}. ` +
          `Production requires PostgreSQL, Redis, S3, and a real LLM provider — silent in-memory fallbacks are forbidden.`
      );
    }
    if (!cfg.llm.model) {
      throw new ConfigurationError("Production configuration error: LLM_MODEL is required.");
    }
  }

  // JWT secret: no default. Production must boot with a real secret.
  cfg.jwtSecret = assertSecretStrength("JWT_SECRET", jwtSecretRaw, isProduction);

  return cfg;
}

function isDevHeadersEnabled(envName: RuntimeConfig["env"]): boolean {
  const flag = env("ALLOW_DEV_HEADERS");
  if (flag !== undefined) {
    return flag === "true" || flag === "1";
  }
  // Fakes/dev headers are a development convenience only. Never default on.
  return false;
}

/**
 * Defensive runtime assertion used by adapter factories: a fake may never be
 * constructed when the runtime is production.
 */
export function assertFakeForbiddenInProduction(runtimeEnv: string | undefined, fakeName: string): void {
  if ((runtimeEnv || process.env.NODE_ENV || "").toLowerCase() === "production") {
    throw new ConfigurationError(
      `Production integrity violation: attempted to construct in-memory fake "${fakeName}". ` +
        `Production must use real PostgreSQL/Redis/S3/LLM adapters.`
    );
  }
}

/** Convenience: generates a cryptographically strong secret (for docs/tests). */
export function generateSecret(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("hex");
}
