import * as crypto from "node:crypto";
import type {
  AuditLog,
  Document,
  DocumentVersion,
  GlossaryEntry,
  HunkDecision,
  IntentCardRecord,
  Membership,
  Organization,
  Project,
  Role,
  TenantContext,
  TranscreationJob,
  User
} from "./models.js";
import type { IGlossaryRepository } from "../core/interfaces.js";
import type { IDatabaseClient } from "./db/client.js";
import { assertFakeForbiddenInProduction } from "./config.js";

export class TenantAccessDeniedError extends Error {
  constructor(message = "Cross-tenant access forbidden: Tenant context mismatch") {
    super(message);
    this.name = "TenantAccessDeniedError";
  }
}

export class InsufficientPermissionsError extends Error {
  constructor(role: string, action: string) {
    super(`Role "${role}" does not have permission to perform action "${action}"`);
    this.name = "InsufficientPermissionsError";
  }
}

export { InsufficientPermissionsError as RolePermissionError };

export type CreateJobInputData = {
  documentId?: string;
  documentVersionId: string;
  projectId?: string;
  targetLocale: string;
  idempotencyKey?: string;
  status?: TranscreationJob["status"];
  progressPercent?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostCents?: number;
};

export interface ISaaSRepository extends IGlossaryRepository {
  createOrganization(data: Omit<Organization, "id" | "createdAt" | "updatedAt">): Promise<Organization>;
  getOrganization(ctx: TenantContext, orgId: string): Promise<Organization | null>;
  createProject(ctx: TenantContext, data: Omit<Project, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<Project>;
  getProject(ctx: TenantContext, projectId: string): Promise<Project | null>;
  listProjects(ctx: TenantContext): Promise<Project[]>;
  updateProject(ctx: TenantContext, projectId: string, update: Partial<Project>): Promise<Project>;
  deleteProject(ctx: TenantContext, projectId: string): Promise<void>;
  createDocument(ctx: TenantContext, data: Omit<Document, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<Document>;
  getDocument(ctx: TenantContext, documentId: string): Promise<Document | null>;
  listDocuments(ctx: TenantContext, projectId: string): Promise<Document[]>;
  createDocumentVersion(ctx: TenantContext, data: Omit<DocumentVersion, "id" | "orgId" | "createdAt">): Promise<DocumentVersion>;
  getDocumentVersions(ctx: TenantContext, documentId: string): Promise<DocumentVersion[]>;
  createJob(ctx: TenantContext, data: CreateJobInputData): Promise<TranscreationJob>;
  createJobWithOutbox(ctx: TenantContext, data: CreateJobInputData): Promise<{ job: TranscreationJob; outboxId: string }>;
  getJob(ctx: TenantContext, jobId: string): Promise<TranscreationJob | null>;
  getJobByIdempotencyKey(ctx: TenantContext, idempotencyKey: string): Promise<TranscreationJob | null>;
  updateJobStatus(ctx: TenantContext, jobId: string, update: Partial<TranscreationJob>): Promise<TranscreationJob>;
  saveIntentCards(ctx: TenantContext, jobId: string, cards: Omit<IntentCardRecord, "id" | "orgId" | "jobId" | "createdAt">[]): Promise<IntentCardRecord[]>;
  getIntentCards(ctx: TenantContext, jobId: string): Promise<IntentCardRecord[]>;
  saveHunkDecision(ctx: TenantContext, decision: Omit<HunkDecision, "id" | "orgId" | "updatedAt">): Promise<HunkDecision>;
  getHunkDecisions(ctx: TenantContext, jobId: string): Promise<HunkDecision[]>;
  saveGlossaryEntry(ctx: TenantContext, entry: Omit<GlossaryEntry, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<GlossaryEntry>;
  getGlossaryEntries(ctx: TenantContext, targetLocale: string, projectId?: string): Promise<GlossaryEntry[]>;
  logAudit(ctx: TenantContext, action: string, resourceType: string, resourceId: string, metadata?: Record<string, any>): Promise<AuditLog>;
  getAuditLogs(ctx: TenantContext): Promise<AuditLog[]>;
  /** Outbox dispatcher support: fetch and claim undispatched outbox events. */
  claimPendingOutboxEvents(ctx: TenantContext, limit?: number): Promise<Array<{ id: string; jobId: string }>>;
  markOutboxDispatched(ctx: TenantContext, outboxId: string): Promise<void>;
}

/* ------------------------------------------------------------------------- */
/* Row mappers (snake_case -> camelCase)                                      */
/* ------------------------------------------------------------------------- */

function mapOrganization(r: any): Organization {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan,
    tokenQuotaMonthly: Number(r.token_quota_monthly),
    tokensUsedThisMonth: Number(r.tokens_used_this_month),
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at)
  };
}

function mapProject(r: any): Project {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    slug: r.slug,
    sourceLocale: r.source_locale,
    targetLocales: r.target_locales ?? [],
    vcsRepositoryUrl: r.vcs_repository_url ?? undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at)
  };
}

function mapDocument(r: any): Document {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    filePath: r.file_path,
    title: r.title ?? undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at)
  };
}

function mapDocumentVersion(r: any): DocumentVersion {
  return {
    id: r.id,
    orgId: r.org_id,
    documentId: r.document_id,
    versionNumber: Number(r.version_number),
    contentHash: r.content_hash,
    content: r.content,
    storageKey: r.s3_storage_key ?? undefined,
    createdBy: r.created_by ?? undefined,
    createdAt: new Date(r.created_at)
  };
}

function mapJob(r: any): TranscreationJob {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id,
    documentId: r.document_id,
    documentVersionId: r.document_version_id,
    targetLocale: r.target_locale,
    status: r.status,
    idempotencyKey: r.idempotency_key,
    progressPercent: Number(r.progress_percent),
    modelUsed: r.model_used ?? undefined,
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    estimatedCostCents: Number(r.estimated_cost_cents),
    errorMessage: r.error_message ?? undefined,
    startedAt: r.started_at ? new Date(r.started_at) : undefined,
    completedAt: r.completed_at ? new Date(r.completed_at) : undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at)
  };
}

function mapIntentCard(r: any): IntentCardRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    jobId: r.job_id,
    sectionIndex: Number(r.section_index),
    codeBlockIndex: r.code_block_index === null ? undefined : Number(r.code_block_index),
    originalMetaphor: r.original_metaphor,
    targetMetaphor: r.target_metaphor,
    mismatchReason: r.mismatch_reason,
    rationale: r.rationale,
    culturalContext: r.cultural_context,
    confidence: Number(r.confidence),
    alternatives: r.alternatives ?? [],
    selectedAlternativeId: r.selected_alternative_id ?? undefined,
    createdAt: new Date(r.created_at)
  };
}

function mapHunkDecision(r: any): HunkDecision {
  return {
    id: r.id,
    orgId: r.org_id,
    jobId: r.job_id,
    hunkIndex: Number(r.hunk_index),
    hunkType: r.hunk_type as "prose" | "code",
    decision: r.decision,
    originalText: r.original_text,
    suggestedText: r.suggested_text,
    finalText: r.final_text,
    reviewerId: r.reviewer_id ?? undefined,
    updatedAt: new Date(r.updated_at)
  };
}

function mapGlossaryEntry(r: any): GlossaryEntry {
  return {
    id: r.id,
    orgId: r.org_id,
    projectId: r.project_id ?? undefined,
    targetLocale: r.target_locale,
    category: r.category,
    sourceTerm: r.source_term,
    targetTerm: r.target_term,
    rationale: r.rationale ?? undefined,
    isApproved: !!r.is_approved,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at)
  };
}

function mapAuditLog(r: any): AuditLog {
  return {
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id ?? undefined,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata ?? {},
    createdAt: new Date(r.created_at)
  };
}

export { mapJob, mapDocumentVersion, mapDocument, mapProject, mapOrganization };

/* ------------------------------------------------------------------------- */
/* POSTGRES-BACKED REPOSITORY (the production repository)                      */
/* ------------------------------------------------------------------------- */

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

function assertTenant(ctx: TenantContext): void {
  if (!ctx || !ctx.orgId) {
    throw new TenantAccessDeniedError("Missing tenant context in security boundary");
  }
}

/**
 * Production repository. EVERY tenant-sensitive operation executes inside
 * withTenantTransaction → BEGIN; SET LOCAL app.current_org_id; …; COMMIT,
 * so PostgreSQL RLS is the second independent tenant boundary.
 *
 * Cross-tenant reads are indistinguishable from missing rows (RLS filters
 * them); mutations that would cross tenants are blocked by policy WITH CHECK
 * → we surface TenantAccessDeniedError consistently at this layer.
 */
export class PostgresTenantScopedRepository implements ISaaSRepository {
  private db: IDatabaseClient;

  constructor(db: IDatabaseClient) {
    this.db = db;
  }

  getDatabaseClient(): IDatabaseClient {
    return this.db;
  }

  private async tx<T>(ctx: TenantContext, fn: (tx: IDatabaseClient) => Promise<T>): Promise<T> {
    assertTenant(ctx);
    return this.db.withTenantTransaction(ctx.orgId, fn);
  }

  private assertRole(ctx: TenantContext, allowed: Role[], action: string): void {
    if (ctx.role && !allowed.includes(ctx.role)) {
      throw new InsufficientPermissionsError(ctx.role, action);
    }
  }

  /* ---------------------------- organizations --------------------------- */

  
  async seedOrganization(org: Organization): Promise<Organization> {
    const query = `
      INSERT INTO organizations (id, name, slug, plan, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const res = await this.db.query(query, [
      org.id, org.name, org.slug, org.plan, org.createdAt, org.updatedAt
    ]);
    return org;
  }

  async createOrganization(data: Omit<Organization, "id" | "createdAt" | "updatedAt">): Promise<Organization> {
    const id = newId("org");
    await this.db.query(
      `INSERT INTO organizations (id, name, slug, plan, token_quota_monthly, tokens_used_this_month)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, data.name, data.slug, data.plan ?? "pro", data.tokenQuotaMonthly ?? 1000000, data.tokensUsedThisMonth ?? 0]
    );
    // Creation context: creator is by definition acting for this new org.
    const res = await this.db.query("SELECT * FROM organizations WHERE id = $1", [id]);
    return mapOrganization(res.rows[0]);
  }

  async getOrganization(ctx: TenantContext, orgId: string): Promise<Organization | null> {
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM organizations WHERE id = $1", [orgId])
    );
    return res.rows.length ? mapOrganization(res.rows[0]) : null;
  }

  /* ------------------------------ projects ----------------------------- */

  async createProject(ctx: TenantContext, data: Omit<Project, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<Project> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createProject");
    const id = newId("proj");
    await this.tx(ctx, async tx => {
      await tx.query(
        `INSERT INTO projects (id, org_id, name, slug, source_locale, target_locales, vcs_repository_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.orgId, data.name, data.slug, data.sourceLocale, data.targetLocales, data.vcsRepositoryUrl ?? null]
      );
      await this.logAudit(ctx, "project.create", "project", id, { name: data.name });
    });
    return (await this.getProject(ctx, id))!;
  }

  async getProject(ctx: TenantContext, projectId: string): Promise<Project | null> {
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM projects WHERE id = $1", [projectId])
    );
    return res.rows.length ? mapProject(res.rows[0]) : null;
  }

  async listProjects(ctx: TenantContext): Promise<Project[]> {
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM projects ORDER BY created_at DESC")
    );
    return res.rows.map(mapProject);
  }

  async updateProject(ctx: TenantContext, projectId: string, update: Partial<Project>): Promise<Project> {
    this.assertRole(ctx, ["owner", "admin"], "updateProject");
    const current = await this.getProject(ctx, projectId);
    if (!current) throw new TenantAccessDeniedError(`Project not found or outside tenant scope: ${projectId}`);
    const next = { ...current, ...update, id: current.id, orgId: current.orgId };
    await this.tx(ctx, async tx => {
      await tx.query(
        `UPDATE projects SET name = $2, slug = $3, source_locale = $4, target_locales = $5, vcs_repository_url = $6, updated_at = NOW()
         WHERE id = $1`,
        [projectId, next.name, next.slug, next.sourceLocale, next.targetLocales, next.vcsRepositoryUrl ?? null]
      );
      await this.logAudit(ctx, "project.update", "project", projectId, { update });
    });
    return (await this.getProject(ctx, projectId))!;
  }

  async deleteProject(ctx: TenantContext, projectId: string): Promise<void> {
    this.assertRole(ctx, ["owner", "admin"], "deleteProject");
    const existing = await this.getProject(ctx, projectId);
    if (!existing) throw new TenantAccessDeniedError(`Project not found or outside tenant scope: ${projectId}`);
    await this.tx(ctx, async tx => {
      await tx.query("DELETE FROM projects WHERE id = $1", [projectId]);
      await this.logAudit(ctx, "project.delete", "project", projectId, {});
    });
  }

  /* ----------------------------- documents ----------------------------- */

  async createDocument(ctx: TenantContext, data: Omit<Document, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<Document> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createDocument");
    const project = await this.getProject(ctx, data.projectId);
    if (!project) throw new TenantAccessDeniedError(`Project not found or outside tenant scope: ${data.projectId}`);
    const id = newId("doc");
    await this.tx(ctx, async tx => {
      await tx.query(
        `INSERT INTO documents (id, org_id, project_id, file_path, title)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, ctx.orgId, data.projectId, data.filePath, data.title ?? null]
      );
      await this.logAudit(ctx, "document.create", "document", id, { filePath: data.filePath });
    });
    return (await this.getDocument(ctx, id))!;
  }

  async getDocument(ctx: TenantContext, documentId: string): Promise<Document | null> {
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM documents WHERE id = $1", [documentId])
    );
    return res.rows.length ? mapDocument(res.rows[0]) : null;
  }

  async listDocuments(ctx: TenantContext, projectId: string): Promise<Document[]> {
    const project = await this.getProject(ctx, projectId);
    if (!project) throw new TenantAccessDeniedError(`Project not found or outside tenant scope: ${projectId}`);
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM documents WHERE project_id = $1 ORDER BY created_at DESC", [projectId])
    );
    return res.rows.map(mapDocument);
  }

  /* ------------------------- document versions ------------------------- */

  async createDocumentVersion(ctx: TenantContext, data: Omit<DocumentVersion, "id" | "orgId" | "createdAt">): Promise<DocumentVersion> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createDocumentVersion");
    const doc = await this.getDocument(ctx, data.documentId);
    if (!doc) throw new TenantAccessDeniedError(`Document not found or outside tenant scope: ${data.documentId}`);
    const id = newId("docver");
    await this.tx(ctx, async tx => {
      await tx.query(
        `INSERT INTO document_versions (id, org_id, document_id, version_number, content_hash, content, s3_storage_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.orgId, data.documentId, data.versionNumber, data.contentHash, data.content, (data as any).s3StorageKey ?? null, data.createdBy ?? null]
      );
      await this.logAudit(ctx, "document_version.create", "document_version", id, { versionNumber: data.versionNumber });
    });
    const res = await this.tx(ctx, tx => tx.query("SELECT * FROM document_versions WHERE id = $1", [id]));
    return mapDocumentVersion(res.rows[0]);
  }

  async getDocumentVersions(ctx: TenantContext, documentId: string): Promise<DocumentVersion[]> {
    const doc = await this.getDocument(ctx, documentId);
    if (!doc) throw new TenantAccessDeniedError(`Document not found or outside tenant scope: ${documentId}`);
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM document_versions WHERE document_id = $1 ORDER BY version_number ASC", [documentId])
    );
    return res.rows.map(mapDocumentVersion);
  }

  /* -------------------------------- jobs ------------------------------- */

  async createJob(ctx: TenantContext, data: CreateJobInputData): Promise<TranscreationJob> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createJob");
    if (data.idempotencyKey) {
      const existing = await this.getJobByIdempotencyKey(ctx, data.idempotencyKey);
      if (existing) return existing;
    }
    let projectId = data.projectId;
    if (!projectId) {
      const doc = await this.getDocument(ctx, data.documentId!);
      if (!doc) throw new TenantAccessDeniedError(`Document not found or outside tenant scope: ${data.documentId}`);
      projectId = doc.projectId;
    }
    const id = newId("job");
    await this.tx(ctx, async tx => {
      await tx.query(
        `INSERT INTO transcreation_jobs (id, org_id, project_id, document_id, document_version_id, target_locale, status, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, ctx.orgId, projectId, data.documentId ?? "default", data.documentVersionId, data.targetLocale, data.status ?? "queued", data.idempotencyKey ?? id]
      );
      await this.logAudit(ctx, "job.create", "job", id, { targetLocale: data.targetLocale });
    });
    return (await this.getJob(ctx, id))!;
  }

  /**
   * Atomic job + outbox event creation (P1 #7). The job row and its dispatch
   * record commit together; the outbox dispatcher then publishes to BullMQ.
   */
  async createJobWithOutbox(ctx: TenantContext, data: CreateJobInputData): Promise<{ job: TranscreationJob; outboxId: string }> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createJob");
    if (data.idempotencyKey) {
      const existing = await this.getJobByIdempotencyKey(ctx, data.idempotencyKey);
      if (existing) {
        // Idempotent re-submission: no duplicate job, no duplicate outbox event.
        const res = await this.tx(ctx, tx =>
          tx.query("SELECT id FROM job_outbox WHERE job_id = $1 AND dispatched_at IS NULL", [existing.id])
        );
        if (res.rows.length) {
          return { job: existing, outboxId: res.rows[0].id };
        }
        return { job: existing, outboxId: "" };
      }
    }
    const job = await this.createJob(ctx, data);
    const outboxId = newId("outbox");
    await this.tx(ctx, tx =>
      tx.query(
        "INSERT INTO job_outbox (id, org_id, job_id) VALUES ($1, $2, $3)",
        [outboxId, ctx.orgId, job.id]
      )
    );
    return { job, outboxId };
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<TranscreationJob | null> {
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM transcreation_jobs WHERE id = $1", [jobId])
    );
    return res.rows.length ? mapJob(res.rows[0]) : null;
  }

  async getJobByIdempotencyKey(ctx: TenantContext, idempotencyKey: string): Promise<TranscreationJob | null> {
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM transcreation_jobs WHERE idempotency_key = $1 ORDER BY created_at ASC LIMIT 1", [idempotencyKey])
    );
    return res.rows.length ? mapJob(res.rows[0]) : null;
  }

  async updateJobStatus(ctx: TenantContext, jobId: string, update: Partial<TranscreationJob>): Promise<TranscreationJob> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "updateJobStatus");
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError(`Job not found or outside tenant scope: ${jobId}`);
    await this.tx(ctx, tx =>
      tx.query(
        `UPDATE transcreation_jobs SET
           status = COALESCE($2::job_status_type, status),
           progress_percent = COALESCE($3, progress_percent),
           model_used = COALESCE($4, model_used),
           prompt_tokens = COALESCE($5, prompt_tokens),
           completion_tokens = COALESCE($6, completion_tokens),
           estimated_cost_cents = COALESCE($7, estimated_cost_cents),
           error_message = $8,
           started_at = COALESCE($9, started_at),
           completed_at = COALESCE($10, completed_at),
           updated_at = NOW()
         WHERE id = $1`,
        [
          jobId,
          update.status ?? null,
          update.progressPercent ?? null,
          update.modelUsed ?? null,
          update.promptTokens ?? null,
          update.completionTokens ?? null,
          update.estimatedCostCents ?? null,
          update.errorMessage ?? null,
          update.startedAt ?? null,
          update.completedAt ?? null
        ]
      )
    );
    return (await this.getJob(ctx, jobId))!;
  }

  /* ---------------------------- intent cards --------------------------- */

  async saveIntentCards(ctx: TenantContext, jobId: string, cards: Omit<IntentCardRecord, "id" | "orgId" | "jobId" | "createdAt">[]): Promise<IntentCardRecord[]> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "saveIntentCards");
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError(`Job not found or outside tenant scope: ${jobId}`);
    await this.tx(ctx, async tx => {
      await tx.query("DELETE FROM intent_cards WHERE job_id = $1", [jobId]);
      for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        await tx.query(
          `INSERT INTO intent_cards (id, org_id, job_id, section_index, code_block_index, original_metaphor, target_metaphor, mismatch_reason, rationale, cultural_context, confidence, alternatives)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [newId("ic"), ctx.orgId, jobId, c.sectionIndex, c.codeBlockIndex ?? null, c.originalMetaphor, c.targetMetaphor, c.mismatchReason, c.rationale, c.culturalContext, c.confidence ?? 0.9, JSON.stringify(c.alternatives ?? [])]
        );
      }
    });
    return this.getIntentCards(ctx, jobId);
  }

  async getIntentCards(ctx: TenantContext, jobId: string): Promise<IntentCardRecord[]> {
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError(`Job not found or outside tenant scope: ${jobId}`);
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM intent_cards WHERE job_id = $1 ORDER BY created_at ASC", [jobId])
    );
    return res.rows.map(mapIntentCard);
  }

  /* --------------------------- hunk decisions -------------------------- */

  async saveHunkDecision(ctx: TenantContext, decision: Omit<HunkDecision, "id" | "orgId" | "updatedAt">): Promise<HunkDecision> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "saveHunkDecision");
    const job = await this.getJob(ctx, decision.jobId);
    if (!job) throw new TenantAccessDeniedError(`Job not found or outside tenant scope: ${decision.jobId}`);
    const id = newId("hd");
    await this.tx(ctx, tx =>
      tx.query(
        `INSERT INTO hunk_decisions (id, org_id, job_id, hunk_index, hunk_type, decision, original_text, suggested_text, final_text, reviewer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (job_id, hunk_index) DO UPDATE SET
           hunk_type = EXCLUDED.hunk_type,
           decision = EXCLUDED.decision,
           original_text = EXCLUDED.original_text,
           suggested_text = EXCLUDED.suggested_text,
           final_text = EXCLUDED.final_text,
           reviewer_id = EXCLUDED.reviewer_id,
           updated_at = NOW()`,
        [id, ctx.orgId, decision.jobId, decision.hunkIndex, decision.hunkType, decision.decision, decision.originalText, decision.suggestedText, decision.finalText, decision.reviewerId ?? null]
      )
    );
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM hunk_decisions WHERE job_id = $1 AND hunk_index = $2", [decision.jobId, decision.hunkIndex])
    );
    return mapHunkDecision(res.rows[0]);
  }

  async getHunkDecisions(ctx: TenantContext, jobId: string): Promise<HunkDecision[]> {
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError(`Job not found or outside tenant scope: ${jobId}`);
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM hunk_decisions WHERE job_id = $1 ORDER BY hunk_index ASC", [jobId])
    );
    return res.rows.map(mapHunkDecision);
  }

  /* ------------------------------ glossary ----------------------------- */

  async saveGlossaryEntry(ctx: TenantContext, entry: Omit<GlossaryEntry, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<GlossaryEntry> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "saveGlossaryEntry");
    if (entry.projectId) {
      const proj = await this.getProject(ctx, entry.projectId);
      if (!proj) throw new TenantAccessDeniedError(`Access denied: Tenant ${ctx.orgId} cannot modify project ${entry.projectId}`);
    }
    await this.tx(ctx, tx =>
      tx.query(
        `INSERT INTO glossary_entries (id, org_id, project_id, target_locale, category, source_term, target_term, rationale, is_approved)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [newId("gl"), ctx.orgId, entry.projectId ?? null, entry.targetLocale, entry.category, entry.sourceTerm, entry.targetTerm, entry.rationale ?? null, entry.isApproved ?? true]
      )
    );
    const res = await this.tx(ctx, tx =>
      tx.query(
        "SELECT * FROM glossary_entries WHERE org_id = $1 AND target_locale = $2 AND source_term = $3 ORDER BY created_at DESC LIMIT 1",
        [ctx.orgId, entry.targetLocale, entry.sourceTerm]
      )
    );
    return mapGlossaryEntry(res.rows[0]);
  }

  async getGlossaryEntries(ctx: TenantContext, targetLocale: string, projectId?: string): Promise<GlossaryEntry[]> {
    const res = await this.tx(ctx, tx =>
      tx.query(
        `SELECT * FROM glossary_entries
         WHERE target_locale = $1 AND (project_id IS NULL OR project_id = $2 OR project_id IS DISTINCT FROM $2 AND $2 IS NULL)
         ORDER BY created_at ASC`,
        [targetLocale, projectId ?? null]
      )
    );
    // project filter semantics: when projectId given, include org-global (NULL) + that project's
    const filtered = projectId
      ? res.rows.filter((r: any) => r.project_id === null || r.project_id === projectId)
      : res.rows;
    return filtered.map(mapGlossaryEntry);
  }

  /* --------------------- engine glossary integration ------------------- */

  async getGlossary(orgId: string, projectId: string | undefined, locale: string): Promise<Record<string, any>> {
    const ctx: TenantContext = { orgId, userId: "system" };
    const entries = await this.getGlossaryEntries(ctx, locale, projectId);
    const result: Record<string, any> = {};
    const symbolTable: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.category === "metaphor") {
        result.primaryMetaphor = entry.targetTerm;
      } else {
        symbolTable[entry.sourceTerm] = entry.targetTerm;
      }
    }
    if (Object.keys(symbolTable).length > 0) {
      result.symbolTable = symbolTable;
    }
    return result;
  }

  async loadGlossary(orgId: string, projectId: string | undefined, locale: string): Promise<Record<string, any>> {
    const mappings = await this.getGlossary(orgId, projectId, locale);
    if (Object.keys(mappings).length === 0) return {};
    return { [locale]: mappings };
  }

  async saveGlossary(orgId: string, projectId: string | undefined, locale: string, mappings: Record<string, any>): Promise<void> {
    if (projectId) {
      const ctx: TenantContext = { orgId, userId: "system" };
      const proj = await this.getProject(ctx, projectId);
      if (!proj) throw new TenantAccessDeniedError(`Access denied: Tenant ${orgId} cannot modify project ${projectId}`);
    }
    const ctx: TenantContext = { orgId, userId: "system", role: "editor" };
    if (mappings.primaryMetaphor) {
      await this.saveGlossaryEntry(ctx, {
        projectId,
        targetLocale: locale,
        category: "metaphor",
        sourceTerm: "primaryMetaphor",
        targetTerm: mappings.primaryMetaphor,
        rationale: "Discovered during transcreation",
        isApproved: true
      });
    }
    if (mappings.symbolTable) {
      for (const [source, target] of Object.entries(mappings.symbolTable)) {
        await this.saveGlossaryEntry(ctx, {
          projectId,
          targetLocale: locale,
          category: "code_identifier",
          sourceTerm: source,
          targetTerm: target as string,
          isApproved: true
        });
      }
    }
  }

  /* ------------------------------- audit ------------------------------- */

  async logAudit(ctx: TenantContext, action: string, resourceType: string, resourceId: string, metadata: Record<string, any> = {}): Promise<AuditLog> {
    assertTenant(ctx);
    const id = newId("aud");
    await this.db.withTenantTransaction(ctx.orgId, tx =>
      tx.query(
        `INSERT INTO audit_logs (id, org_id, user_id, action, resource_type, resource_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ctx.orgId, ctx.userId ?? null, action, resourceType, resourceId, JSON.stringify(metadata ?? {})]
      )
    );
    return {
      id,
      orgId: ctx.orgId,
      userId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      createdAt: new Date()
    };
  }

  async getAuditLogs(ctx: TenantContext): Promise<AuditLog[]> {
    this.assertRole(ctx, ["owner", "admin"], "getAuditLogs");
    const res = await this.tx(ctx, tx =>
      tx.query("SELECT * FROM audit_logs WHERE org_id = $1 ORDER BY created_at DESC LIMIT 500", [ctx.orgId])
    );
    return res.rows.map(mapAuditLog);
  }

  /* ------------------------------- outbox ------------------------------ */

  async claimPendingOutboxEvents(ctx: TenantContext, limit = 50): Promise<Array<{ id: string; jobId: string }>> {
    const res = await this.tx(ctx, tx =>
      tx.query(
        `SELECT id, job_id FROM job_outbox
         WHERE dispatched_at IS NULL AND attempts < 10
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit]
      )
    );
    return res.rows.map((r: any) => ({ id: r.id, jobId: r.job_id }));
  }

  async markOutboxDispatched(ctx: TenantContext, outboxId: string): Promise<void> {
    await this.tx(ctx, tx =>
      tx.query("UPDATE job_outbox SET dispatched_at = NOW() WHERE id = $1", [outboxId])
    );
  }
}
