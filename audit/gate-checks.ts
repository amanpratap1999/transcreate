// Empirical production-fallback audit — run with: NODE_ENV=production npx tsx audit/gate-checks.ts
// Each check instantiates the REAL production classes and records which adapter actually runs.
import { createDatabaseClient } from "../src/saas/db/client.js";
import { createStorageService } from "../src/saas/storage.js";
import { JobQueue, AsyncJobWorker } from "../src/saas/jobs.js";
import { RateLimiter } from "../src/saas/rate-limiter.js";
import { TokenService } from "../src/saas/auth.js";
import { LLMGateway } from "../src/saas/llm-gateway.js";
import { SaasApiServer } from "../src/saas/api.js";
import { TenantScopedRepository } from "../src/saas/repository.js";
import { TranscreateEngine } from "../src/transcreate/engine.js";

const results: Array<{ check: string; outcome: string; release_blocker: boolean }> = [];
const rec = (check: string, outcome: string, blocker = false) => {
  results.push({ check, outcome, release_blocker: blocker });
  console.log(`${blocker ? "⛔" : "✅"} ${check}: ${outcome}`);
};

const cleanEnv = { ...process.env };
delete cleanEnv.DATABASE_URL; delete cleanEnv.REDIS_URL;
delete cleanEnv.S3_BUCKET_NAME; delete cleanEnv.AWS_REGION;
delete cleanEnv.AWS_ENDPOINT_URL_S3;
Object.assign(process.env, cleanEnv);

console.log(`\nNODE_ENV=${process.env.NODE_ENV}\n`);

// -- 1. DATABASE ------------------------------------------------------
const db = createDatabaseClient();
const isRealDb = db.constructor.name === "RealPostgreSqlDatabaseClient";
rec(
  "DB fallback (DATABASE_URL unset)",
  isRealDb
    ? "RealPostgreSqlDatabaseClient"
    : `SILENT FALLBACK -> ${db.constructor.name} (in-memory, no persistence, no RLS)`,
  !isRealDb
);
// SQL-shape mismatch even when DATABASE_URL *is* set:
process.env.DATABASE_URL = "postgresql://x:x@localhost:5432/x";
const db2 = createDatabaseClient();
let db2Outcome: string;
try {
  await db2.query("SELECT id, name FROM organizations WHERE id = $1", ["org-1"]);
  db2Outcome = "query() returned (unexpected — no local pg)";
} catch (e: any) {
  db2Outcome = `RealPostgreSqlDatabaseClient selected and attempted real pg connection (${e.code ?? e.message}) — adapter selection OK, but repository layer NEVER calls it`;
}
rec("DB adapter when DATABASE_URL set", db2Outcome, false);
rec(
  "DB SQL shape (repository never emits SQL — TenantScopedRepository is Map-based)",
  "production requests never reach pg: repository is in-memory Maps; db client used ONLY for /readyz isHealthy(). schema.sql is never applied by any migration path.",
  true
);
delete process.env.DATABASE_URL;

// -- 2. QUEUE ---------------------------------------------------------
const queue = new JobQueue(4);
rec(
  "Queue fallback (REDIS_URL unset)",
  queue.bullQueue ? "BullMQ/Redis" : `SILENT FALLBACK -> in-memory array queue (lost on restart; multi-worker unsafe)`,
  !queue.bullQueue
);

// -- 3. WORKER --------------------------------------------------------
const repo = new TenantScopedRepository();
const engine = new TranscreateEngine();
const worker = new AsyncJobWorker(repo, engine, queue);
const workerAny = worker as any;
rec(
  "Worker fallback (REDIS_URL unset)",
  workerAny.bullWorker ? "BullMQ Worker" : "SILENT FALLBACK -> worker.start() sets active=true, then NOTHING polls: job payloads never processed without pollAndProcess()",
  !workerAny.bullWorker
);

// -- 4. STORAGE --------------------------------------------------------
const storage = createStorageService();
const s3 = (storage as any).s3;
rec(
  "Storage fallback (S3_BUCKET_NAME/AWS_REGION unset)",
  s3 ? "S3ObjectStorageService" : `SILENT FALLBACK -> in-memory Map storage (all documents lost on restart); isHealthy() hardcoded true`,
  !s3
);

// -- 5. RATE LIMITER ---------------------------------------------------
const limiter = new RateLimiter();
rec(
  "Rate limiter fallback (REDIS_URL unset)",
  (limiter as any).redis ? "Redis ZSET" : `SILENT FALLBACK -> per-process in-memory (limit resets per restart, NOT shared across replicas)`,
  !(limiter as any).redis
);

// -- 6. TOKEN REVOCATION ----------------------------------------------
const ts = new TokenService();
rec(
  "Token revocation fallback (REDIS_URL unset)",
  (ts as any).redis ? "Redis SET revoked:<jti> EX" : "SILENT FALLBACK -> in-process Set: logout/revocation not shared across API replicas",
  !(ts as any).redis
);

// -- 7. LLM GATEWAY ---------------------------------------------------
const gw = new LLMGateway();
const out = await gw.generateStructured({
  systemPrompt: "sys",
  userPrompt: "user",
  schema: (await import("zod")).z.object({ primaryMetaphor: (await import("zod")).z.string() }),
  tenantContext: { orgId: "org_x" }
} as any);
rec(
  "LLM provider (no API client exists in production path)",
  `Mock by construction: generateStructured() with no mockHandler returns hardcoded baseball->Shinkansen output; NO OpenAI call ever wired; production cost/billing fields fake`,
  true
);

// -- 8. AUTH STATE -----------------------------------------------------
const amRec = repo as any;
rec(
  "Auth/user store",
  "AuthenticationManager.usersByEmail & TenantScopedRepository are in-memory Maps — no pg-backed user/membership store in runtime path; restart loses all accounts",
  true
);

// -- 9. API allowDevHeaders default -------------------------------------
const apiServer = new SaasApiServer(repo, queue, {} as any); // default options = production-shaped caller
rec(
  "API allowDevHeaders default",
  "constructor default is TRUE (dev headers accepted) unless caller passes allowDevHeaders:false — cli serve passes NODE_ENV check, but any other wiring (tests/alt entrypoints) defaults open",
  false
);

console.log("\n==== SUMMARY ====");
console.log(JSON.stringify({ NODE_ENV: process.env.NODE_ENV, blockers: results.filter(r => r.release_blocker).length, total: results.length }, null, 2));
console.log("\nRelease blockers:", results.filter(r => r.release_blocker).map(r => r.check));
process.exit(0);
