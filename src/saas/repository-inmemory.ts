import { TenantAccessDeniedError, InsufficientPermissionsError } from "./repository.js";
/**
 * TEST/DEVELOPMENT FAKE — in-memory TenantScopedRepository.
 *
 * This class is NOT part of the production runtime:
 *  - constructing it when NODE_ENV=production throws (fail closed)
 *  - unit tests import it explicitly; nothing in src/saas production paths
 *    constructs it from ambient environment
 *
 * The production repository is PostgresTenantScopedRepository (repository.ts),
 * which executes every tenant operation inside withTenantTransaction with
 * SET LOCAL app.current_org_id (real RLS).
 */
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
import { assertFakeForbiddenInProduction } from "./config.js";
import type { ISaaSRepository, CreateJobInputData } from "./repository.js";
export { InsufficientPermissionsError as RolePermissionError } from "./repository.js";

/**
 * In-memory fake of the SaaS repository for unit tests (explicit injection only).
 */
export class InMemoryTenantScopedRepository implements ISaaSRepository {
  private orgs = new Map<string, Organization>();
  private users = new Map<string, User>();
  private memberships = new Map<string, Membership>();
  private projects = new Map<string, Project>();
  private documents = new Map<string, Document>();
  private documentVersions = new Map<string, DocumentVersion[]>();
  private jobs = new Map<string, TranscreationJob>();
  private intentCards = new Map<string, IntentCardRecord[]>();
  private hunkDecisions = new Map<string, Map<number, HunkDecision>>();
  private glossaryEntries = new Map<string, GlossaryEntry[]>();
  private auditLogs: AuditLog[] = [];
  private outbox = new Map<string, { id: string; jobId: string; dispatchedAt?: Date }>();

  constructor() {
    assertFakeForbiddenInProduction(process.env.NODE_ENV, "InMemoryTenantScopedRepository");
  }

  private assertTenant(ctx: TenantContext, resourceOrgId: string): void {
    if (!ctx || !ctx.orgId) {
      throw new TenantAccessDeniedError("Missing tenant context in security boundary");
    }
    if (ctx.orgId !== resourceOrgId) {
      throw new TenantAccessDeniedError("Access denied: Tenant " + ctx.orgId + " cannot access resource belonging to " + resourceOrgId);
    }
  }

  private assertRole(ctx: TenantContext, allowedRoles: Role[], action: string): void {
    if (ctx.role && !allowedRoles.includes(ctx.role)) {
      throw new InsufficientPermissionsError(ctx.role, action);
    }
  }

  public seedOrganization(org: Organization): void {
    this.orgs.set(org.id, org);
  }

  async createOrganization(data: Omit<Organization, "id" | "createdAt" | "updatedAt">): Promise<Organization> {
    const id = "org-" + crypto.randomUUID().slice(0, 8);
    const org: Organization = { ...data, id, createdAt: new Date(), updatedAt: new Date() };
    this.orgs.set(id, org);
    return org;
  }

  async getOrganization(ctx: TenantContext, orgId: string): Promise<Organization | null> {
    this.assertTenant(ctx, orgId);
    return this.orgs.get(orgId) ?? null;
  }

  async createProject(ctx: TenantContext, data: Omit<Project, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<Project> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createProject");
    const id = "proj-" + crypto.randomUUID().slice(0, 8);
    const project: Project = { ...data, id, orgId: ctx.orgId, createdAt: new Date(), updatedAt: new Date() };
    this.projects.set(id, project);
    await this.logAudit(ctx, "project.create", "project", id, { name: data.name });
    return project;
  }

  async getProject(ctx: TenantContext, projectId: string): Promise<Project | null> {
    const project = this.projects.get(projectId);
    if (!project) return null;
    this.assertTenant(ctx, project.orgId);
    return project;
  }

  async listProjects(ctx: TenantContext): Promise<Project[]> {
    return Array.from(this.projects.values()).filter(p => p.orgId === ctx.orgId);
  }

  async updateProject(ctx: TenantContext, projectId: string, update: Partial<Project>): Promise<Project> {
    this.assertRole(ctx, ["owner", "admin"], "updateProject");
    const project = await this.getProject(ctx, projectId);
    if (!project) throw new TenantAccessDeniedError("Project not found: " + projectId);
    const updated: Project = { ...project, ...update, id: project.id, orgId: project.orgId, updatedAt: new Date() };
    this.projects.set(projectId, updated);
    await this.logAudit(ctx, "project.update", "project", projectId, update);
    return updated;
  }

  async deleteProject(ctx: TenantContext, projectId: string): Promise<void> {
    this.assertRole(ctx, ["owner", "admin"], "deleteProject");
    const project = await this.getProject(ctx, projectId);
    if (!project) throw new TenantAccessDeniedError("Project not found: " + projectId);
    this.projects.delete(projectId);
    await this.logAudit(ctx, "project.delete", "project", projectId, {});
  }

  async createDocument(ctx: TenantContext, data: Omit<Document, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<Document> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createDocument");
    const project = await this.getProject(ctx, data.projectId);
    if (!project) throw new TenantAccessDeniedError("Project not found: " + data.projectId);
    const id = "doc-" + crypto.randomUUID().slice(0, 8);
    const doc: Document = { ...data, id, orgId: ctx.orgId, createdAt: new Date(), updatedAt: new Date() };
    this.documents.set(id, doc);
    await this.logAudit(ctx, "document.create", "document", id, { filePath: data.filePath });
    return doc;
  }

  async getDocument(ctx: TenantContext, documentId: string): Promise<Document | null> {
    const doc = this.documents.get(documentId);
    if (!doc) return null;
    this.assertTenant(ctx, doc.orgId);
    return doc;
  }

  async listDocuments(ctx: TenantContext, projectId: string): Promise<Document[]> {
    const project = await this.getProject(ctx, projectId);
    if (!project) throw new TenantAccessDeniedError("Project not found: " + projectId);
    return Array.from(this.documents.values()).filter(d => d.projectId === projectId && d.orgId === ctx.orgId);
  }

  async createDocumentVersion(ctx: TenantContext, data: Omit<DocumentVersion, "id" | "orgId" | "createdAt">): Promise<DocumentVersion> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createDocumentVersion");
    const doc = await this.getDocument(ctx, data.documentId);
    if (!doc) throw new TenantAccessDeniedError("Document not found: " + data.documentId);
    const id = "docver-" + crypto.randomUUID().slice(0, 8);
    const version: DocumentVersion = { ...data, id, orgId: ctx.orgId, createdAt: new Date() };
    const list = this.documentVersions.get(data.documentId) ?? [];
    list.push(version);
    this.documentVersions.set(data.documentId, list);
    await this.logAudit(ctx, "document_version.create", "document_version", id, { versionNumber: data.versionNumber });
    return version;
  }

  async getDocumentVersions(ctx: TenantContext, documentId: string): Promise<DocumentVersion[]> {
    const doc = await this.getDocument(ctx, documentId);
    if (!doc) throw new TenantAccessDeniedError("Document not found: " + documentId);
    return this.documentVersions.get(documentId) ?? [];
  }

  async createJob(ctx: TenantContext, data: CreateJobInputData): Promise<TranscreationJob> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "createJob");
    if (data.idempotencyKey) {
      const existing = await this.getJobByIdempotencyKey(ctx, data.idempotencyKey);
      if (existing) return existing;
    }
    const id = "job-" + crypto.randomUUID().slice(0, 8);
    const job: TranscreationJob = {
      id,
      orgId: ctx.orgId,
      projectId: data.projectId || ctx.projectId || "default",
      documentId: data.documentId || "default",
      documentVersionId: data.documentVersionId,
      targetLocale: data.targetLocale,
      idempotencyKey: data.idempotencyKey || id,
      status: data.status || "queued",
      progressPercent: data.progressPercent || 0,
      promptTokens: data.promptTokens || 0,
      completionTokens: data.completionTokens || 0,
      estimatedCostCents: data.estimatedCostCents || 0,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.jobs.set(id, job);
    await this.logAudit(ctx, "job.create", "job", id, { targetLocale: data.targetLocale });
    return job;
  }

  async createJobWithOutbox(ctx: TenantContext, data: CreateJobInputData): Promise<{ job: TranscreationJob; outboxId: string }> {
    const job = await this.createJob(ctx, data);
    const existing = [...this.outbox.values()].find(o => o.jobId === job.id);
    if (existing) return { job, outboxId: existing.id };
    const outboxId = "outbox-" + crypto.randomUUID().slice(0, 8);
    this.outbox.set(outboxId, { id: outboxId, jobId: job.id });
    return { job, outboxId };
  }

  async getJob(ctx: TenantContext, jobId: string): Promise<TranscreationJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    this.assertTenant(ctx, job.orgId);
    return job;
  }

  async getJobByIdempotencyKey(ctx: TenantContext, idempotencyKey: string): Promise<TranscreationJob | null> {
    for (const job of this.jobs.values()) {
      if (job.orgId === ctx.orgId && job.idempotencyKey === idempotencyKey) {
        return job;
      }
    }
    return null;
  }

  async updateJobStatus(ctx: TenantContext, jobId: string, update: Partial<TranscreationJob>): Promise<TranscreationJob> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "updateJobStatus");
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError("Job not found: " + jobId);
    const updated: TranscreationJob = { ...job, ...update, updatedAt: new Date() };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async saveIntentCards(ctx: TenantContext, jobId: string, cards: Omit<IntentCardRecord, "id" | "orgId" | "jobId" | "createdAt">[]): Promise<IntentCardRecord[]> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "saveIntentCards");
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError("Job not found: " + jobId);
    const records: IntentCardRecord[] = cards.map((c, i) => ({
      ...c,
      id: "ic-" + jobId + "-" + i,
      orgId: ctx.orgId,
      jobId,
      createdAt: new Date()
    }));
    this.intentCards.set(jobId, records);
    return records;
  }

  async getIntentCards(ctx: TenantContext, jobId: string): Promise<IntentCardRecord[]> {
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError("Job not found: " + jobId);
    return this.intentCards.get(jobId) ?? [];
  }

  async saveHunkDecision(ctx: TenantContext, decision: Omit<HunkDecision, "id" | "orgId" | "updatedAt">): Promise<HunkDecision> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "saveHunkDecision");
    const job = await this.getJob(ctx, decision.jobId);
    if (!job) throw new TenantAccessDeniedError("Job not found: " + decision.jobId);
    let jobMap = this.hunkDecisions.get(decision.jobId);
    if (!jobMap) {
      jobMap = new Map<number, HunkDecision>();
      this.hunkDecisions.set(decision.jobId, jobMap);
    }
    const record: HunkDecision = {
      ...decision,
      id: "hd-" + decision.jobId + "-" + decision.hunkIndex,
      orgId: ctx.orgId,
      updatedAt: new Date()
    };
    jobMap.set(decision.hunkIndex, record);
    return record;
  }

  async getHunkDecisions(ctx: TenantContext, jobId: string): Promise<HunkDecision[]> {
    const job = await this.getJob(ctx, jobId);
    if (!job) throw new TenantAccessDeniedError("Job not found: " + jobId);
    const map = this.hunkDecisions.get(jobId);
    return map ? Array.from(map.values()).sort((a, b) => a.hunkIndex - b.hunkIndex) : [];
  }

  async saveGlossaryEntry(ctx: TenantContext, entry: Omit<GlossaryEntry, "id" | "orgId" | "createdAt" | "updatedAt">): Promise<GlossaryEntry> {
    this.assertRole(ctx, ["owner", "admin", "editor"], "saveGlossaryEntry");
    if (entry.projectId) {
      const proj = this.projects.get(entry.projectId);
      if (proj && proj.orgId !== ctx.orgId) {
        throw new TenantAccessDeniedError(`Access denied: Tenant ${ctx.orgId} cannot modify project ${entry.projectId}`);
      }
    }
    let list = this.glossaryEntries.get(ctx.orgId) ?? [];
    const existingIdx = list.findIndex(
      g => g.targetLocale === entry.targetLocale && g.sourceTerm === entry.sourceTerm && g.projectId === entry.projectId
    );
    const record: GlossaryEntry = {
      ...entry,
      id: "gl-" + crypto.randomUUID().slice(0, 8),
      orgId: ctx.orgId,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    if (existingIdx >= 0) {
      list[existingIdx] = record;
    } else {
      list.push(record);
    }
    this.glossaryEntries.set(ctx.orgId, list);
    return record;
  }

  async getGlossaryEntries(ctx: TenantContext, targetLocale: string, projectId?: string): Promise<GlossaryEntry[]> {
    const list = this.glossaryEntries.get(ctx.orgId) ?? [];
    return list.filter(
      g => g.targetLocale === targetLocale && (!projectId || !g.projectId || g.projectId === projectId)
    );
  }

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
      const proj = this.projects.get(projectId);
      if (proj && proj.orgId !== orgId) {
        throw new TenantAccessDeniedError(`Access denied: Tenant ${orgId} cannot modify project ${projectId}`);
      }
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

  async logAudit(ctx: TenantContext, action: string, resourceType: string, resourceId: string, metadata: Record<string, any> = {}): Promise<AuditLog> {
    const log: AuditLog = {
      id: "aud-" + crypto.randomUUID().slice(0, 8),
      orgId: ctx.orgId,
      userId: ctx.userId,
      action,
      resourceType,
      resourceId,
      metadata,
      createdAt: new Date()
    };
    this.auditLogs.push(log);
    return log;
  }

  async getAuditLogs(ctx: TenantContext): Promise<AuditLog[]> {
    this.assertRole(ctx, ["owner", "admin"], "getAuditLogs");
    return this.auditLogs.filter(a => a.orgId === ctx.orgId);
  }

  async claimPendingOutboxEvents(_ctx: TenantContext, _limit?: number): Promise<Array<{ id: string; jobId: string }>> {
    return [...this.outbox.values()].filter(o => !o.dispatchedAt).map(o => ({ id: o.id, jobId: o.jobId }));
  }

  async markOutboxDispatched(_ctx: TenantContext, outboxId: string): Promise<void> {
    const o = this.outbox.get(outboxId);
    if (o) o.dispatchedAt = new Date();
  }
}
