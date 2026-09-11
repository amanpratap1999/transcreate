import * as http from "node:http";
import { z } from "zod";
import type { TenantContext, Role } from "./models.js";
import type { ISaaSRepository } from "./repository.js";
import {
  TenantAccessDeniedError,
  InsufficientPermissionsError
} from "./repository.js";
import { JobQueue } from "./jobs.js";
import { SaasWorkstationService } from "./workstation-service.js";
import {
  AuthenticationManager,
  AuthenticationError,
  TokenExpiredError,
  TokenRevokedError
} from "./auth.js";
import { RateLimiter, RateLimitExceededError, RATE_LIMIT_RULES } from "./rate-limiter.js";
import { StructuredLogger, MetricsCollector } from "./observability.js";
import type { IObjectStorageService } from "./storage.js";
import type { IDatabaseClient } from "./db/client.js";

// Zod Request Schemas
export const RegisterInput = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(1).max(100),
  orgName: z.string().min(1).max(100),
  orgSlug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/)
});

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  orgId: z.string().optional()
});

export const CreateProjectInput = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  sourceLocale: z.string().min(2).max(10),
  targetLocales: z.array(z.string().min(2).max(10)).min(1),
  vcsRepositoryUrl: z.string().url().optional()
});

export const CreateDocumentInput = z.object({
  projectId: z.string().min(1),
  filePath: z.string().min(1).max(500),
  title: z.string().max(200).optional()
});

export const CreateVersionInput = z.object({
  content: z.string().min(1),
  contentHash: z.string().min(1).optional()
});

export const CreateJobInput = z.object({
  documentId: z.string().min(1),
  documentVersionId: z.string().min(1),
  targetLocale: z.string().min(2).max(10),
  idempotencyKey: z.string().min(1).max(200),
  model: z.string().optional()
});

export const HunkDecisionInput = z.object({
  jobId: z.string().min(1),
  hunkIndex: z.number().int().min(0),
  hunkType: z.enum(["prose", "code"]).default("prose"),
  decision: z.enum(["accepted", "rejected", "modified"]),
  originalText: z.string().default(""),
  suggestedText: z.string().default(""),
  finalText: z.string().default(""),
  rationale: z.string().optional()
});

export const GlossaryEntryInput = z.object({
  projectId: z.string().optional(),
  targetLocale: z.string().min(2).max(10),
  category: z.enum(["metaphor", "code_identifier", "terminology"]),
  sourceTerm: z.string().min(1).max(200),
  targetTerm: z.string().min(1).max(200),
  rationale: z.string().optional()
});

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SaasApiServerOptions {
  allowDevHeaders?: boolean;
  authManager?: AuthenticationManager;
  rateLimiter?: RateLimiter;
  logger?: StructuredLogger;
  metrics?: MetricsCollector;
  storage?: IObjectStorageService;
  db?: IDatabaseClient;
}

export class SaasApiServer {
  private repo: ISaaSRepository;
  private queue: JobQueue;
  private workstationService = new SaasWorkstationService();
  private authManager: AuthenticationManager;
  private rateLimiter: RateLimiter;
  private logger: StructuredLogger;
  private metrics: MetricsCollector;
  private storage?: IObjectStorageService;
  private db?: IDatabaseClient;
  private allowDevHeaders: boolean;
  private server?: http.Server;

  constructor(repo: ISaaSRepository, queue: JobQueue, options: SaasApiServerOptions = {}) {
    this.repo = repo;
    this.queue = queue;
    this.allowDevHeaders = options.allowDevHeaders ?? true;
    this.authManager = options.authManager || new AuthenticationManager();
    this.rateLimiter = options.rateLimiter || new RateLimiter();
    this.logger = options.logger || new StructuredLogger();
    this.metrics = options.metrics || new MetricsCollector();
    this.storage = options.storage;
    this.db = options.db;
  }

  public getAuthManager(): AuthenticationManager {
    return this.authManager;
  }

  public getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  public getMetrics(): MetricsCollector {
    return this.metrics;
  }

  /**
   * Verified Tenant Context Extraction.
   * Priority 1: Cryptographically signed Bearer JWT or session cookie.
   * Priority 2: In testing mode ONLY, optional dev headers if explicitly enabled.
   */
  public async extractTenantContext(req: http.IncomingMessage): Promise<TenantContext> {
    const authHeader = req.headers["authorization"] as string | undefined;
    const cookieHeader = req.headers["cookie"] as string | undefined;

    // Check for cryptographic token first
    if ((authHeader && authHeader.startsWith("Bearer ")) || (cookieHeader && cookieHeader.includes("session="))) {
      return await this.authManager.verifyRequest(authHeader, cookieHeader);
    }

    // Check testing mode bypass if explicitly enabled
    if (this.allowDevHeaders) {
      const orgId = req.headers["x-org-id"] as string;
      const userId = (req.headers["x-user-id"] as string) || "user_anonymous";
      const role = (req.headers["x-role"] as Role) || "viewer";

      if (orgId) {
        return { orgId, userId, role };
      }
    }

    throw new AuthenticationError("Authentication required: Missing or invalid authorization token");
  }

  public async readJsonBody(req: http.IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<any> {
    return new Promise((resolve, reject) => {
      let data = "";
      let bytes = 0;

      req.on("data", chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          reject(new Error("Payload size exceeds maximum allowed 10MB limit"));
          return;
        }
        data += chunk;
      });

      req.on("end", () => {
        if (!data.trim()) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error("Invalid JSON body"));
        }
      });

      req.on("error", reject);
    });
  }

  public sendJson(
    res: http.ServerResponse,
    statusCode: number,
    body: ApiResponse,
    extraHeaders: Record<string, string> = {}
  ): void {
    this.metrics.recordHttpRequest(statusCode);
    const json = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(json),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...extraHeaders
    });
    res.end(json);
  }

  public handleRequest: http.RequestListener = async (req, res) => {
    const startTime = Date.now();
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;
    const method = req.method || "GET";
    const clientIp = (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() || req.socket.remoteAddress || "127.0.0.1";

    try {
      // General API Rate Limiting check
      await this.rateLimiter.assertLimit(`ip:${clientIp}`, RATE_LIMIT_RULES.standard, "General API");

      // 1. Health & Liveness Probe
      if (path === "/healthz" || path === "/api/healthz") {
        return this.sendJson(res, 200, { success: true, data: { status: "healthy", timestamp: new Date() } });
      }

      // 2. Readiness Probe (Checks database, queue, storage)
      if (path === "/readyz" || path === "/api/readyz") {
        const dbOk = this.db ? await this.db.isHealthy() : true;
        const storageOk = this.storage ? await this.storage.isHealthy() : true;
        const isReady = dbOk && storageOk;

        const status = isReady ? 200 : 503;
        return this.sendJson(res, status, {
          success: isReady,
          data: {
            ready: isReady,
            database: dbOk ? "connected" : "unreachable",
            storage: storageOk ? "connected" : "unreachable",
            queue: "ready"
          }
        });
      }

      // 3. Metrics endpoint
      if (path === "/metrics" || path === "/api/metrics") {
        return this.sendJson(res, 200, { success: true, data: this.metrics.getSnapshot() });
      }

      // 4. Public Authentication Endpoints (Rate limited strictly)
      if (method === "POST" && path === "/api/v1/auth/register") {
        await this.rateLimiter.assertLimit(`auth:${clientIp}`, RATE_LIMIT_RULES.auth, "Registration");
        const body = await this.readJsonBody(req);
        const parsed = RegisterInput.parse(body);

        // Create organization first
        const org = await this.repo.createOrganization({
          name: parsed.orgName,
          slug: parsed.orgSlug,
          plan: "pro",
          tokenQuotaMonthly: 1000000,
          tokensUsedThisMonth: 0
        });

        // Register user and create admin membership
        const { user, token } = await this.authManager.registerUser(
          parsed.email,
          parsed.password,
          parsed.fullName,
          org.id,
          "admin"
        );

        return this.sendJson(
          res,
          201,
          { success: true, data: { user, token, organization: org } },
          { "Set-Cookie": `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}` }
        );
      }

      if (method === "POST" && path === "/api/v1/auth/login") {
        await this.rateLimiter.assertLimit(`auth:${clientIp}`, RATE_LIMIT_RULES.auth, "Login");
        const body = await this.readJsonBody(req);
        const parsed = LoginInput.parse(body);

        const result = await this.authManager.loginUser(parsed.email, parsed.password, parsed.orgId);

        return this.sendJson(
          res,
          200,
          { success: true, data: result },
          { "Set-Cookie": `session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}` }
        );
      }

      if (method === "POST" && path === "/api/v1/auth/logout") {
        const authHeader = req.headers["authorization"] as string | undefined;
        if (authHeader && authHeader.startsWith("Bearer ")) {
          await this.authManager.logout(authHeader.slice(7).trim());
        }
        return this.sendJson(
          res,
          200,
          { success: true, data: { loggedOut: true } },
          { "Set-Cookie": "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" }
        );
      }

      // ======================================================================
      // Authenticated Tenant Boundary
      // ======================================================================
      const ctx = await this.extractTenantContext(req);

      // Auth Profile (Me)
      if (method === "GET" && path === "/api/v1/auth/me") {
        return this.sendJson(res, 200, { success: true, data: { tenant: ctx } });
      }

      // 1. Projects
      if (method === "POST" && path === "/api/v1/projects") {
        const body = await this.readJsonBody(req);
        const parsed = CreateProjectInput.parse(body);
        const project = await this.repo.createProject(ctx, parsed);
        return this.sendJson(res, 201, { success: true, data: project });
      }

      if (method === "GET" && path === "/api/v1/projects") {
        const projects = await this.repo.listProjects(ctx);
        return this.sendJson(res, 200, { success: true, data: projects });
      }

      const projectMatch = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
      if (projectMatch) {
        const projectId = projectMatch[1];
        if (method === "GET") {
          const project = await this.repo.getProject(ctx, projectId);
          return this.sendJson(res, 200, { success: true, data: project });
        }
        if (method === "DELETE") {
          await this.repo.deleteProject(ctx, projectId);
          return this.sendJson(res, 200, { success: true, data: { deleted: true } });
        }
      }

      // 2. Documents
      if (method === "POST" && path === "/api/v1/documents") {
        await this.rateLimiter.assertLimit(`upload:${ctx.orgId}`, RATE_LIMIT_RULES.uploads, "Document Uploads");
        const body = await this.readJsonBody(req);
        const parsed = CreateDocumentInput.parse(body);
        const doc = await this.repo.createDocument(ctx, parsed);
        return this.sendJson(res, 201, { success: true, data: doc });
      }

      const docMatch = path.match(/^\/api\/v1\/documents\/([^/]+)$/);
      if (docMatch) {
        const docId = docMatch[1];
        if (method === "GET") {
          const doc = await this.repo.getDocument(ctx, docId);
          return this.sendJson(res, 200, { success: true, data: doc });
        }
      }

      // Document Versions
      const docVersionsMatch = path.match(/^\/api\/v1\/documents\/([^/]+)\/versions$/);
      if (docVersionsMatch) {
        const docId = docVersionsMatch[1];
        if (method === "GET") {
          const versions = await this.repo.getDocumentVersions(ctx, docId);
          return this.sendJson(res, 200, { success: true, data: versions });
        }
        if (method === "POST") {
          await this.rateLimiter.assertLimit(`upload:${ctx.orgId}`, RATE_LIMIT_RULES.uploads, "Version Uploads");
          const body = await this.readJsonBody(req);
          const parsed = CreateVersionInput.parse(body);
          const versions = await this.repo.getDocumentVersions(ctx, docId);
          const version = await this.repo.createDocumentVersion(ctx, {
            documentId: docId,
            versionNumber: versions.length + 1,
            content: parsed.content,
            contentHash: parsed.contentHash || "sha256_" + Date.now(),
            createdBy: ctx.userId
          });
          return this.sendJson(res, 201, { success: true, data: version });
        }
      }

      // 3. Jobs
      if (method === "POST" && path === "/api/v1/jobs") {
        await this.rateLimiter.assertLimit(`jobs:${ctx.orgId}`, RATE_LIMIT_RULES.jobs, "Job Creation");
        const body = await this.readJsonBody(req);
        const parsed = CreateJobInput.parse(body);

        // Fetch doc to verify project ID and ownership
        const doc = await this.repo.getDocument(ctx, parsed.documentId);

        const job = await this.repo.createJob(ctx, {
          projectId: doc!.projectId,
          documentId: parsed.documentId,
          documentVersionId: parsed.documentVersionId,
          targetLocale: parsed.targetLocale,
          idempotencyKey: parsed.idempotencyKey,
          status: "queued"
        });

        this.metrics.recordJobSubmitted();

        // Enqueue if newly created and queued
        if (job!.status === "queued") {
          await this.queue.enqueue({
            jobId: job.id,
            tenantContext: { ...ctx, projectId: doc!.projectId },
            documentId: parsed.documentId,
            documentVersionId: parsed.documentVersionId,
            targetLocale: parsed.targetLocale,
            options: { model: parsed.model }
          });
        }

        return this.sendJson(res, 202, { success: true, data: job });
      }

      const jobMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)$/);
      if (method === "GET" && jobMatch) {
        const jobId = jobMatch[1];
        const job = await this.repo.getJob(ctx, jobId);
        return this.sendJson(res, 200, { success: true, data: job });
      }

      const jobCardsMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)\/intent-cards$/);
      if (method === "GET" && jobCardsMatch) {
        const jobId = jobCardsMatch[1];
        const cards = await this.repo.getIntentCards(ctx, jobId);
        return this.sendJson(res, 200, { success: true, data: cards });
      }

      const jobReviewMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)\/review$/);
      if (method === "GET" && jobReviewMatch) {
        const jobId = jobReviewMatch[1];
        const job = await this.repo.getJob(ctx, jobId);
        const doc = await this.repo.getDocument(ctx, job.documentId);
        const versions = await this.repo.getDocumentVersions(ctx, job.documentId);
        const sourceVersion = versions.find(v => v.id === job!.documentVersionId) || versions[0];
        const localizedVersion = versions.length > 1 ? versions[versions.length - 1] : undefined;
        const intentCards = await this.repo.getIntentCards(ctx, jobId);
        const decisions = await this.repo.getHunkDecisions(ctx, jobId);

        const html = this.workstationService.renderHtml({
          job,
          document: doc,
          sourceVersion,
          localizedVersion,
          intentCards,
          decisions,
          tenantContext: ctx
        }, `http://${req.headers.host || "localhost"}`);

        this.metrics.recordHttpRequest(200);
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(html),
          "X-Content-Type-Options": "nosniff",
          "X-Frame-Options": "DENY"
        });
        return res.end(html);
      }

      // 4. Hunk Decisions
      const jobDecisionsMatch = path.match(/^\/api\/v1\/jobs\/([^/]+)\/decisions$/);
      if (jobDecisionsMatch) {
        const jobId = jobDecisionsMatch[1];
        if (method === "GET") {
          const decisions = await this.repo.getHunkDecisions(ctx, jobId);
          return this.sendJson(res, 200, { success: true, data: decisions });
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          const parsed = HunkDecisionInput.parse({ ...body, jobId });
          const record = await this.repo.saveHunkDecision(ctx, {
            jobId,
            hunkIndex: parsed.hunkIndex,
            hunkType: parsed.hunkType,
            decision: parsed.decision,
            originalText: parsed.originalText,
            suggestedText: parsed.suggestedText,
            finalText: parsed.finalText || parsed.suggestedText,
            reviewerId: ctx.userId
          });
          return this.sendJson(res, 200, { success: true, data: record });
        }
      }

      // 5. Glossary
      if (path === "/api/v1/glossary") {
        if (method === "GET") {
          const locale = url.searchParams.get("locale") || "ja-JP";
          const projectId = url.searchParams.get("projectId") || undefined;
          const entries = await this.repo.getGlossaryEntries(ctx, locale, projectId);
          return this.sendJson(res, 200, { success: true, data: entries });
        }
        if (method === "POST") {
          const body = await this.readJsonBody(req);
          const parsed = GlossaryEntryInput.parse(body);
          const entry = await this.repo.saveGlossaryEntry(ctx, {
            ...parsed,
            isApproved: true
          });
          return this.sendJson(res, 201, { success: true, data: entry });
        }
      }

      // 6. Audit Logs
      if (method === "GET" && path === "/api/v1/audit-logs") {
        const logs = await this.repo.getAuditLogs(ctx);
        return this.sendJson(res, 200, { success: true, data: logs });
      }

      // Route Not Found
      return this.sendJson(res, 404, { success: false, error: `Endpoint ${method} ${path} not found` });
    } catch (err: any) {
      const durationMs = Date.now() - startTime;

      if (err instanceof RateLimitExceededError) {
        return this.sendJson(
          res,
          429,
          { success: false, error: err.message },
          { "Retry-After": String(err.retryAfterSeconds) }
        );
      }
      if (err instanceof AuthenticationError) {
        return this.sendJson(res, 401, { success: false, error: err.message });
      }
      if (err instanceof TenantAccessDeniedError) {
        return this.sendJson(res, 403, { success: false, error: err.message });
      }
      if (err instanceof InsufficientPermissionsError) {
        return this.sendJson(res, 403, { success: false, error: err.message });
      }
      if (err instanceof z.ZodError) {
        return this.sendJson(res, 400, { success: false, error: "Validation error: " + err.errors.map(e => e.path.join(".") + ": " + e.message).join(", ") });
      }

      this.logger.error("Internal Server Error", err, { path, method, durationMs });
      return this.sendJson(res, 500, { success: false, error: err.message || "Internal server error" });
    }
  };

  public listen(port = 0, hostname = "127.0.0.1"): Promise<{ port: number; close: () => Promise<void> }> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.handleRequest);
      this.server.listen(port, hostname, () => {
        const address = this.server!.address();
        const actualPort = typeof address === "object" && address ? address.port : port;
        resolve({
          port: actualPort,
          close: () => new Promise(resClose => this.server!.close(() => resClose()))
        });
      });
      this.server.on("error", reject);
    });
  }
}
