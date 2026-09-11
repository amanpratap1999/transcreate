import { z } from "zod";

export const RoleSchema = z.enum(["owner", "admin", "editor", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const JobStatusSchema = z.enum([
  "queued",
  "processing",
  "review_ready",
  "approved",
  "completed",
  "failed",
  "cancelled"
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const HunkDecisionTypeSchema = z.enum(["accepted", "rejected", "modified"]);
export type HunkDecisionType = z.infer<typeof HunkDecisionTypeSchema>;

export const GlossaryCategorySchema = z.enum(["metaphor", "code_identifier", "terminology"]);
export type GlossaryCategory = z.infer<typeof GlossaryCategorySchema>;

export interface TenantContext {
  orgId: string;
  userId: string;
  role?: Role;
  projectId?: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: "free" | "pro" | "enterprise";
  tokenQuotaMonthly: number;
  tokensUsedThisMonth: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string;
  isSuperadmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Membership {
  id: string;
  orgId: string;
  userId: string;
  role: Role;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  sourceLocale: string;
  targetLocales: string[];
  vcsRepositoryUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Document {
  id: string;
  orgId: string;
  projectId: string;
  filePath: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocumentVersion {
  id: string;
  orgId: string;
  documentId: string;
  versionNumber: number;
  contentHash: string;
  content: string;
  createdBy?: string;
  createdAt: Date;
}

export interface GlossaryEntry {
  id: string;
  orgId: string;
  projectId?: string;
  targetLocale: string;
  category: GlossaryCategory;
  sourceTerm: string;
  targetTerm: string;
  rationale?: string;
  isApproved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TranscreationJob {
  id: string;
  orgId: string;
  projectId: string;
  documentId: string;
  documentVersionId: string;
  targetLocale: string;
  status: JobStatus;
  idempotencyKey: string;
  progressPercent: number;
  modelUsed?: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostCents: number;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntentCardRecord {
  id: string;
  orgId: string;
  jobId: string;
  sectionIndex: number;
  codeBlockIndex?: number;
  originalMetaphor: string;
  targetMetaphor: string;
  mismatchReason: string;
  rationale: string;
  culturalContext: string;
  confidence: number;
  alternatives: Array<{
    id: string;
    metaphor: string;
    rationale: string;
    suggestedText: string;
    isNeutralTechnical: boolean;
  }>;
  selectedAlternativeId?: string;
  createdAt: Date;
}

export interface HunkDecision {
  id: string;
  orgId: string;
  jobId: string;
  hunkIndex: number;
  hunkType: "prose" | "code";
  decision: HunkDecisionType;
  originalText: string;
  suggestedText: string;
  finalText: string;
  reviewerId?: string;
  updatedAt: Date;
}

export interface AuditLog {
  id: string;
  orgId: string;
  userId?: string;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: Record<string, any>;
  createdAt: Date;
}