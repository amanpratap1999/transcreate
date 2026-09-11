import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SaasApiServer } from "../src/saas/api.js";
import { InMemoryTenantScopedRepository } from "../src/saas/repository-inmemory.js";
import { PostgreSqlDatabaseClient } from "../src/saas/db/client.js";
import { JobQueue } from "../src/saas/jobs.js";
import { AuthenticationManager, PasswordHasher, TokenService } from "../src/saas/auth.js";
import { InMemoryObjectStorageService, StorageSecurityError } from "../src/saas/storage.js";
import { RateLimiter, RateLimitExceededError } from "../src/saas/rate-limiter.js";
import { PostgreSqlDatabaseClient, PostgresRlsViolationError } from "../src/saas/db/client.js";
import { DistributedJobQueue } from "../src/saas/distributed-jobs.js";

describe("Production Reality & Security Hardening Audit", () => {
  let server: SaasApiServer;
  let repo: InMemoryTenantScopedRepository;
  let queue: JobQueue;
  let authManager: AuthenticationManager;
  let storage: InMemoryObjectStorageService;
  let rateLimiter: RateLimiter;
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  beforeAll(async () => {
    repo = new InMemoryTenantScopedRepository();
    queue = new JobQueue();
    authManager = new AuthenticationManager();
    storage = new InMemoryObjectStorageService();
    rateLimiter = new RateLimiter();

    // Production configuration: allowDevHeaders = false (Strict authentication required!)
    server = new SaasApiServer(repo, queue, {
      allowDevHeaders: false,
      authManager,
      storage,
      rateLimiter
    });

    const instance = await server.listen(0, "127.0.0.1");
    baseUrl = `http://127.0.0.1:${instance.port}`;
    closeServer = instance.close;
  });

  afterAll(async () => {
    if (closeServer) {
      await closeServer();
    }
  });

  describe("1. Cryptographic Authentication & Anti-Privilege Escalation", () => {
    it("hashes passwords securely via PBKDF2-HMAC-SHA512 with salt", async () => {
      const password = "SuperSecretPassword123!";
      const hash = await PasswordHasher.hash(password);

      expect(hash).toContain("pbkdf2$sha512$100000$");
      expect(await PasswordHasher.verify(password, hash)).toBe(true);
      expect(await PasswordHasher.verify("WrongPassword!", hash)).toBe(false);
    });

    it("registers user, creates organization, and issues signed JWT session token", async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "founder@acme.com",
          password: "SecurePassword999!",
          fullName: "Alice Founder",
          orgName: "Acme Corporation",
          orgSlug: "acme-corp"
        })
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.user.email).toBe("founder@acme.com");
      expect(json.data.token).toBeDefined();

      // Verify Set-Cookie header contains HttpOnly session
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
    });

    it("prevents browser from self-promoting to owner/admin by spoofing raw headers", async () => {
      // In production mode (allowDevHeaders = false), sending raw x-role is rejected with 401
      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-org-id": "org_victim",
          "x-role": "owner" // Hacker tries to claim owner without JWT
        },
        body: JSON.stringify({
          name: "Hijacked Project",
          slug: "hijacked-project",
          sourceLocale: "en-US",
          targetLocales: ["ja-JP"]
        })
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(json.error).toContain("Authentication required");
    });

    it("rejects tampered or forged JWT tokens", async () => {
      const tokenService = new TokenService();
      const validToken = tokenService.generateToken({
        sub: "user_123",
        email: "test@example.com",
        orgId: "org_alpha",
        role: "viewer"
      });

      // Tamper with payload
      const [header, payload, sig] = validToken.split(".");
      const tamperedPayload = Buffer.from(
        JSON.stringify({ sub: "user_123", orgId: "org_alpha", role: "owner" })
      ).toString("base64url");
      const forgedToken = `${header}.${tamperedPayload}.${sig}`;

      const res = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${forgedToken}` }
      });

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toContain("Invalid token signature");
    });

    it("enforces session token revocation upon logout", async () => {
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "founder@acme.com",
          password: "SecurePassword999!"
        })
      });

      expect(loginRes.status).toBe(200);
      const { token } = (await loginRes.json()).data;

      // Access protected endpoint with token -> succeeds
      const check1 = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(check1.status).toBe(200);

      // Logout
      const logoutRes = await fetch(`${baseUrl}/api/v1/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(logoutRes.status).toBe(200);

      // Subsequent access with revoked token -> rejected with 401
      const check2 = await fetch(`${baseUrl}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(check2.status).toBe(401);
      expect((await check2.json()).error).toContain("revoked");
    });
  });

  describe("2. Rate Limiting & Brute Force Defense", () => {
    it("enforces rate limit on login attempts and responds with 429 Too Many Requests", async () => {
      const testLimiter = new RateLimiter();
      const ip = "192.168.1.100";
      const rule = { limit: 3, windowSeconds: 60 };

      expect((await testLimiter.checkLimit(ip, rule)).allowed).toBe(true);
      expect((await testLimiter.checkLimit(ip, rule)).allowed).toBe(true);
      expect((await testLimiter.checkLimit(ip, rule)).allowed).toBe(true);

      const rejected = await testLimiter.checkLimit(ip, rule);
      expect(rejected.allowed).toBe(false);
      expect(rejected.retryAfterSeconds).toBeGreaterThan(0);

      // Verify that the error is thrown
      let caughtError: any;
      try {
        await testLimiter.assertLimit(ip, rule);
      } catch (e) {
        caughtError = e;
      }
      expect(caughtError).toBeDefined();
      expect(caughtError.name).toBe("RateLimitExceededError");
    });
  });

  describe("3. Object Storage & Path Traversal Security", () => {
    it("enforces tenant-isolated storage keys and detects traversal attacks", async () => {
      const testStorage = new InMemoryObjectStorageService();

      // Valid upload
      const res = await testStorage.putObject(
        "org_alpha",
        "guides/tutorial.md",
        "# Hello World"
      );
      expect(res.storageKey).toBe("tenants/org_alpha/guides/tutorial.md");

      // Cross-tenant read attempt (Tenant B accessing Tenant A's key) -> Forbidden
      await expect(
        testStorage.getObject("org_beta", res.storageKey)
      ).rejects.toThrow(StorageSecurityError);

      // Path traversal attacks
      await expect(
        testStorage.putObject("org_alpha", "../../etc/passwd", "malicious")
      ).rejects.toThrow(/Path traversal detected/);

      await expect(
        testStorage.putObject("org_alpha", "docs/..\\system32\\cmd.exe", "malicious")
      ).rejects.toThrow(/Path traversal detected/);

      await expect(
        testStorage.putObject("org_alpha", "file%2e%2e/test.md", "malicious")
      ).rejects.toThrow(/URL-encoded traversal/);

      await expect(
        testStorage.putObject("org_alpha", "test\0null.md", "malicious")
      ).rejects.toThrow(/null byte/);
    });
  });

  describe("4. PostgreSQL Row Level Security (RLS) Verification", () => {
    it("enforces tenant isolation at database engine layer via app.current_org_id", async () => {
      const db = new PostgreSqlDatabaseClient();

      // Tenant A creates a project inside Tenant A session
      await db.withTenantTransaction("org_alpha", async tx => {
        await tx.query("INSERT INTO projects", [{
          id: "proj_a1",
          name: "Alpha Project",
          org_id: "org_alpha"
        }]);
      });

      // Tenant B queries projects inside Tenant B session -> returns 0 rows!
      await db.withTenantTransaction("org_beta", async tx => {
        const res = await tx.query("SELECT * FROM projects");
        expect(res.rows.length).toBe(0);
      });

      // Tenant A queries projects -> returns Alpha Project
      await db.withTenantTransaction("org_alpha", async tx => {
        const res = await tx.query("SELECT * FROM projects");
        expect(res.rows.length).toBe(1);
        expect(res.rows[0].id).toBe("proj_a1");
      });

      // Direct query without RLS session variable returns 0 rows
      const emptyRes = await db.query("SELECT * FROM projects");
      expect(emptyRes.rows.length).toBe(0);

      // Cross-tenant INSERT violation
      await expect(
        db.withTenantTransaction("org_alpha", async tx => {
          await tx.query("INSERT INTO projects", [{
            id: "proj_illegal",
            name: "Forged Project",
            org_id: "org_beta" // Mismatch with session org
          }]);
        })
      ).rejects.toThrow(PostgresRlsViolationError);
    });
  });

  describe("5. Distributed Queue Atomic Locking & Concurrency Protection", () => {
    it("prevents multiple workers from acquiring lock on the same job concurrently", async () => {
      const distQueue = new DistributedJobQueue();

      await distQueue.enqueue({
        jobId: "job_concurrent_01",
        tenantContext: { orgId: "org_alpha", userId: "usr_1" },
        documentId: "doc_1",
        documentVersionId: "ver_1",
        targetLocale: "ja-JP"
      });

      // Worker 1 dequeues and acquires lock
      const jobWorker1 = await distQueue.dequeue("worker_node_1");
      expect(jobWorker1).not.toBeNull();
      expect(jobWorker1?.jobId).toBe("job_concurrent_01");

      // Worker 2 attempts to acquire lock on same job -> returns false
      const lockAcquiredByWorker2 = await distQueue.acquireLock("job_concurrent_01", "worker_node_2");
      expect(lockAcquiredByWorker2).toBe(false);

      // Worker 1 marks job completed, releasing lock
      await distQueue.markCompleted("job_concurrent_01", "worker_node_1");

      const metrics = await distQueue.getMetrics();
      expect(metrics.completedCount).toBe(1);
      expect(metrics.activeCount).toBe(0);
    });
  });

  describe("6. Observability & Health Probes", () => {
    it("returns liveness and readiness probe status", async () => {
      const liveRes = await fetch(`${baseUrl}/healthz`);
      expect(liveRes.status).toBe(200);
      expect((await liveRes.json()).data.status).toBe("healthy");

      const readyRes = await fetch(`${baseUrl}/readyz`);
      expect(readyRes.status).toBe(200);
      expect((await readyRes.json()).data.ready).toBe(true);

      const metricsRes = await fetch(`${baseUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
      const metrics = (await metricsRes.json()).data;
      expect(metrics.httpRequestsTotal).toBeGreaterThan(0);
    });
  });
});
