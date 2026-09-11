import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SaasApiServer } from "../src/saas/api.js";
import { InMemoryTenantScopedRepository } from "../src/saas/repository-inmemory.js";
import { PostgreSqlDatabaseClient } from "../src/saas/db/client.js";
import { JobQueue, AsyncJobWorker } from "../src/saas/jobs.js";
import { TranscreateEngine } from "../src/transcreate/engine.js";

describe("SaaS Multi-Tenant REST API Gateway & Security Verification", () => {
  let server: SaasApiServer;
  let repo: InMemoryTenantScopedRepository;
  let queue: JobQueue;
  let worker: AsyncJobWorker;
  let baseUrl: string;
  let closeServer: () => Promise<void>;

  const orgA = "org_api_alpha";
  const orgB = "org_api_beta";

  beforeAll(async () => {
    repo = new InMemoryTenantScopedRepository();
    queue = new JobQueue(2);
    const engine = new TranscreateEngine();
    worker = new AsyncJobWorker(repo, engine, queue);
    server = new SaasApiServer(repo, queue);

    // Seed organizations
    repo.seedOrganization({
      id: orgA,
      name: "Alpha Corp",
      slug: "alpha-corp",
      plan: "enterprise",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    repo.seedOrganization({
      id: orgB,
      name: "Beta Corp",
      slug: "beta-corp",
      plan: "pro",
      createdAt: new Date(),
      updatedAt: new Date()
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

  const apiRequest = async (
    path: string,
    options: {
      method?: string;
      orgId?: string;
      userId?: string;
      role?: string;
      body?: any;
    } = {}
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (options.orgId) headers["x-org-id"] = options.orgId;
    if (options.userId) headers["x-user-id"] = options.userId;
    if (options.role) headers["x-role"] = options.role;

    const res = await fetch(`${baseUrl}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const json = await res.json();
    return { status: res.status, data: json };
  };

  describe("1. Health Check & Public Endpoints", () => {
    it("returns healthy status on /healthz without authentication", async () => {
      const res = await apiRequest("/healthz");
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.status).toBe("healthy");
    });
  });

  describe("2. Authentication & Security Boundary", () => {
    it("rejects unauthenticated requests lacking credentials with 401", async () => {
      const res = await apiRequest("/api/v1/projects");
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toContain("Authentication required");
    });

    it("enforces RBAC over HTTP: viewer role cannot create project", async () => {
      const res = await apiRequest("/api/v1/projects", {
        method: "POST",
        orgId: orgA,
        userId: "user_viewer",
        role: "viewer",
        body: {
          name: "Unauthorized Project",
          slug: "unauthorized-proj",
          sourceLocale: "en-US",
          targetLocales: ["ja-JP"]
        }
      });
      expect(res.status).toBe(403);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toContain("does not have permission");
    });
  });

  describe("3. End-to-End Multi-Tenant Project & Document Lifecycle", () => {
    let createdProjectId: string;
    let createdDocId: string;
    let createdVersionId: string;
    let createdJobId: string;

    it("allows admin to create a project and enforces validation schema", async () => {
      // Invalid slug (spaces) -> 400 Bad Request
      const invalidRes = await apiRequest("/api/v1/projects", {
        method: "POST",
        orgId: orgA,
        userId: "user_admin",
        role: "admin",
        body: {
          name: "Bad Project",
          slug: "bad slug with spaces",
          sourceLocale: "en-US",
          targetLocales: ["ja-JP"]
        }
      });
      expect(invalidRes.status).toBe(400);

      // Valid project creation -> 201 Created
      const validRes = await apiRequest("/api/v1/projects", {
        method: "POST",
        orgId: orgA,
        userId: "user_admin",
        role: "admin",
        body: {
          name: "Acme Web Docs",
          slug: "acme-web-docs",
          sourceLocale: "en-US",
          targetLocales: ["ja-JP", "de-DE"]
        }
      });

      expect(validRes.status).toBe(201);
      expect(validRes.data.success).toBe(true);
      expect(validRes.data.data.id).toBeDefined();
      expect(validRes.data.data.orgId).toBe(orgA);
      createdProjectId = validRes.data.data.id;
    });

    it("creates a document and uploads document version", async () => {
      const docRes = await apiRequest("/api/v1/documents", {
        method: "POST",
        orgId: orgA,
        userId: "user_editor",
        role: "editor",
        body: {
          projectId: createdProjectId,
          filePath: "guides/queues.md",
          title: "Asynchronous Queues Guide"
        }
      });
      expect(docRes.status).toBe(201);
      expect(docRes.data.success).toBe(true);
      createdDocId = docRes.data.data.id;

      // Upload Version
      const verRes = await apiRequest(`/api/v1/documents/${createdDocId}/versions`, {
        method: "POST",
        orgId: orgA,
        userId: "user_editor",
        role: "editor",
        body: {
          content: "# Queue Architecture\n\nEvents are queued in a baseball bullpen before dispatch."
        }
      });
      expect(verRes.status).toBe(201);
      expect(verRes.data.data.versionNumber).toBe(1);
      createdVersionId = verRes.data.data.id;
    });

    it("submits transcreation job, enqueues asynchronously, and tracks completion", async () => {
      const jobRes = await apiRequest("/api/v1/jobs", {
        method: "POST",
        orgId: orgA,
        userId: "user_editor",
        role: "editor",
        body: {
          documentId: createdDocId,
          documentVersionId: createdVersionId,
          targetLocale: "ja-JP",
          idempotencyKey: "job_api_test_001"
        }
      });

      expect(jobRes.status).toBe(202);
      expect(jobRes.data.success).toBe(true);
      createdJobId = jobRes.data.data.id;
      expect(jobRes.data.data.status).toBe("queued");

      // Process job via worker
      const processedVersion = await worker.pollAndProcess();
      expect(processedVersion).not.toBeNull();

      // Check job status over API
      const statusRes = await apiRequest(`/api/v1/jobs/${createdJobId}`, {
        orgId: orgA,
        userId: "user_viewer",
        role: "viewer"
      });
      expect(statusRes.status).toBe(200);
      expect(statusRes.data.data.status).toBe("completed");
      expect(statusRes.data.data.progressPercent).toBe(100);

      // Check Intent Cards over API
      const cardsRes = await apiRequest(`/api/v1/jobs/${createdJobId}/intent-cards`, {
        orgId: orgA,
        userId: "user_viewer",
        role: "viewer"
      });
      expect(cardsRes.status).toBe(200);
      expect(cardsRes.data.data.length).toBeGreaterThan(0);
    });

    it("records reviewer hunk decisions via POST /api/v1/jobs/:id/decisions", async () => {
      const decRes = await apiRequest(`/api/v1/jobs/${createdJobId}/decisions`, {
        method: "POST",
        orgId: orgA,
        userId: "user_reviewer",
        role: "editor",
        body: {
          hunkIndex: 0,
          hunkType: "prose",
          decision: "accepted",
          originalText: "bullpen queue",
          suggestedText: "shinkansen waitline",
          finalText: "shinkansen waitline"
        }
      });
      expect(decRes.status).toBe(200);
      expect(decRes.data.success).toBe(true);

      const listDec = await apiRequest(`/api/v1/jobs/${createdJobId}/decisions`, {
        orgId: orgA,
        userId: "user_viewer",
        role: "viewer"
      });
      expect(listDec.status).toBe(200);
      expect(listDec.data.data.length).toBe(1);
      expect(listDec.data.data[0].decision).toBe("accepted");
    });

    it("renders the SaaS web review workstation with live cloud sync via GET /api/v1/jobs/:id/review", async () => {
      const res = await fetch(`${baseUrl}/api/v1/jobs/${createdJobId}/review`, {
        headers: {
          "x-org-id": orgA,
          "x-user-id": "user_viewer",
          "x-role": "viewer"
        }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("Transcreate Review");
      expect(html).toContain(orgA);
      expect(html).toContain("window.saveToSaaSCloud");

      // Tenant B gets 403 Forbidden
      const crossRes = await fetch(`${baseUrl}/api/v1/jobs/${createdJobId}/review`, {
        headers: {
          "x-org-id": orgB,
          "x-user-id": "hacker_bob",
          "x-role": "admin"
        }
      });
      expect(crossRes.status).toBe(403);
    });

    it("prevents Tenant B from accessing Tenant A's project, document, or job (Anti-IDOR/BOLA)", async () => {
      // Tenant B tries to get Tenant A's project
      const crossProj = await apiRequest(`/api/v1/projects/${createdProjectId}`, {
        orgId: orgB,
        userId: "hacker_bob",
        role: "admin"
      });
      expect(crossProj.status).toBe(403);
      expect(crossProj.data.success).toBe(false);

      // Tenant B tries to get Tenant A's document
      const crossDoc = await apiRequest(`/api/v1/documents/${createdDocId}`, {
        orgId: orgB,
        userId: "hacker_bob",
        role: "admin"
      });
      expect(crossDoc.status).toBe(403);

      // Tenant B tries to inspect Tenant A's job
      const crossJob = await apiRequest(`/api/v1/jobs/${createdJobId}`, {
        orgId: orgB,
        userId: "hacker_bob",
        role: "admin"
      });
      expect(crossJob.status).toBe(403);
    });

    it("manages project glossary entries with isolation", async () => {
      // Add glossary entry for Tenant A
      const postGlossary = await apiRequest("/api/v1/glossary", {
        method: "POST",
        orgId: orgA,
        userId: "user_editor",
        role: "editor",
        body: {
          projectId: createdProjectId,
          targetLocale: "ja-JP",
          category: "metaphor",
          sourceTerm: "pitcher",
          targetTerm: "denshaUntenshi",
          rationale: "Train driver metaphor"
        }
      });
      expect(postGlossary.status).toBe(201);

      // Query glossary as Tenant A
      const queryA = await apiRequest(`/api/v1/glossary?locale=ja-JP&projectId=${createdProjectId}`, {
        orgId: orgA,
        userId: "user_viewer",
        role: "viewer"
      });
      expect(queryA.status).toBe(200);
      expect(queryA.data.data.length).toBeGreaterThanOrEqual(1);
      const customEntry = queryA.data.data.find((e: any) => e.sourceTerm === "pitcher");
      expect(customEntry).toBeDefined();
      expect(customEntry.targetTerm).toBe("denshaUntenshi");

      // Query glossary as Tenant B -> returns 0 entries
      const queryB = await apiRequest("/api/v1/glossary?locale=ja-JP", {
        orgId: orgB,
        userId: "user_viewer",
        role: "viewer"
      });
      expect(queryB.status).toBe(200);
      expect(queryB.data.data.length).toBe(0);
    });

    it("records and isolates audit logs across tenants", async () => {
      const logsA = await apiRequest("/api/v1/audit-logs", {
        orgId: orgA,
        userId: "user_admin",
        role: "admin"
      });
      expect(logsA.status).toBe(200);
      expect(logsA.data.data.length).toBeGreaterThan(0);

      const logsB = await apiRequest("/api/v1/audit-logs", {
        orgId: orgB,
        userId: "user_admin",
        role: "admin"
      });
      expect(logsB.status).toBe(200);
      expect(logsB.data.data.length).toBe(0);
    });
  });
});
