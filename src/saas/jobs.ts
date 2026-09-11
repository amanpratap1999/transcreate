import { EventEmitter } from "node:events";
import { Queue as BullQueue, Worker } from "bullmq";
import { Redis } from "ioredis";
import type {
  TenantContext,
  TranscreationJob,
  JobStatus,
  IntentCardRecord,
  DocumentVersion
} from "./models.js";
import type { ISaaSRepository } from "./repository.js";
import { TranscreateEngine } from "../transcreate/engine.js";
import type { ILLMProvider } from "../core/interfaces.js";

export interface QueueJobPayload {
  jobId: string;
  tenantContext: TenantContext;
  documentId: string;
  documentVersionId: string;
  targetLocale: string;
  options?: {
    model?: string;
    glossaryPath?: string;
  };
  retryCount?: number;
  maxRetries?: number;
}

export interface JobProgressEvent {
  jobId: string;
  orgId: string;
  progressPercent: number;
  stage: string;
  status: JobStatus;
}

export class JobQueue extends EventEmitter {
  private queue: QueueJobPayload[] = [];
  private processing = new Map<string, QueueJobPayload>();
  private dlq: Array<{ payload: QueueJobPayload; error: string; failedAt: Date }> = [];
  private concurrency: number;
  public bullQueue?: BullQueue;
  private redisConnection?: Redis;

  constructor(concurrency = 4) {
    super();
    this.concurrency = concurrency;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("FATAL: REDIS_URL is required for JobQueue in non-test environments.");
      }
    } else {
      this.redisConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      this.bullQueue = new BullQueue("transcreate-jobs", { connection: this.redisConnection });
    }
  }

  public async enqueue(payload: QueueJobPayload): Promise<void> {
    const jobPayload: QueueJobPayload = {
      ...payload,
      retryCount: payload.retryCount ?? 0,
      maxRetries: payload.maxRetries ?? 3
    };

    if (this.bullQueue) {
      await this.bullQueue.add(jobPayload.jobId, jobPayload, {
        jobId: jobPayload.jobId,
        attempts: jobPayload.maxRetries,
        backoff: { type: "exponential", delay: 1000 }
      });
    } else {
      this.queue.push(jobPayload);
    }
    this.emit("enqueued", jobPayload);
  }

  public getQueueLength(): number {
    return this.queue.length;
  }

  public getActiveCount(): number {
    return this.processing.size;
  }

  public getDLQ(): Array<{ payload: QueueJobPayload; error: string; failedAt: Date }> {
    return [...this.dlq];
  }

  public getNextJob(): QueueJobPayload | null {
    if (this.processing.size >= this.concurrency || this.queue.length === 0) {
      return null;
    }
    const next = this.queue.shift()!;
    this.processing.set(next.jobId, next);
    return next;
  }

  public markCompleted(jobId: string): void {
    this.processing.delete(jobId);
    this.emit("completed", jobId);
  }

  public markFailed(jobId: string, error: Error, retryable = true): void {
    const payload = this.processing.get(jobId);
    this.processing.delete(jobId);

    if (!payload) return;

    if (retryable && (payload.retryCount ?? 0) < (payload.maxRetries ?? 3)) {
      payload.retryCount = (payload.retryCount ?? 0) + 1;
      this.queue.push(payload);
      this.emit("retrying", { jobId, retryCount: payload.retryCount, error: error.message });
    } else {
      this.dlq.push({
        payload,
        error: error.message,
        failedAt: new Date()
      });
      this.emit("failed_dlq", { jobId, error: error.message });
    }
  }
}

export class AsyncJobWorker {
  private repo: ISaaSRepository;
  private engine: TranscreateEngine;
  private queue: JobQueue;
  private llmProvider?: ILLMProvider;
  private active = false;

  private bullWorker?: Worker;

  constructor(
    repo: ISaaSRepository,
    engine: TranscreateEngine,
    queue: JobQueue,
    llmProvider?: ILLMProvider
  ) {
    this.repo = repo;
    this.engine = engine;
    this.queue = queue;
    this.llmProvider = llmProvider;
  }

  public start(): void {
    this.active = true;
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      if (process.env.NODE_ENV !== "test") {
        throw new Error("FATAL: REDIS_URL is required for AsyncJobWorker in non-test environments.");
      }
    } else {
      const redisConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      this.bullWorker = new Worker("transcreate-jobs", async job => {
        return await this.processJob(job.data as QueueJobPayload);
      }, { connection: redisConnection });
    }
  }

  public stop(): void {
    this.active = false;
    if (this.bullWorker) {
      this.bullWorker.close();
    }
  }

  /**
   * Process a single queued transcreation job with stage progress tracking,
   * surgical markdown transcreation, AST validation, intent card recording,
   * and automated version creation.
   */
  public async processJob(payload: QueueJobPayload): Promise<DocumentVersion> {
    const { jobId, tenantContext, documentId, documentVersionId, targetLocale, options } = payload;

    try {
      // 1. Mark status = processing, progress = 10%
      await this.repo.updateJobStatus(tenantContext, jobId, {
        status: "processing",
        progressPercent: 10,
        startedAt: new Date()
      });
      this.queue.emit("progress", {
        jobId,
        orgId: tenantContext.orgId,
        progressPercent: 10,
        stage: "FETCHING_SOURCE",
        status: "processing"
      } satisfies JobProgressEvent);

      // 2. Fetch source document and version
      const doc = await this.repo.getDocument(tenantContext, documentId);
      const versions = await this.repo.getDocumentVersions(tenantContext, documentId);
      const sourceVersion = versions.find(v => v.id === documentVersionId);

      if (!sourceVersion) {
        throw new Error(`Source document version "${documentVersionId}" not found for document "${documentId}"`);
      }

      // 3. Stage 2: Parsing and AST Analysis (30%)
      await this.repo.updateJobStatus(tenantContext, jobId, { progressPercent: 30 });
      this.queue.emit("progress", {
        jobId,
        orgId: tenantContext.orgId,
        progressPercent: 30,
        stage: "AST_PARSING",
        status: "processing"
      } satisfies JobProgressEvent);

      // 4. Run Core Transcreation Pipeline with injected tenant context and repository
      const transcreateRes = await this.engine.transcreate(sourceVersion.content, {
        filePath: doc.filePath,
        targetLocale,
        glossaryRepo: this.repo,
        tenantContext,
        llmProvider: this.llmProvider,
        model: options?.model
      });

      // 5. Stage 3: Code Validation and Bottom-Up Splice (70%)
      await this.repo.updateJobStatus(tenantContext, jobId, { progressPercent: 70 });
      this.queue.emit("progress", {
        jobId,
        orgId: tenantContext.orgId,
        progressPercent: 70,
        stage: "VALIDATING_AND_SPLICING",
        status: "processing"
      } satisfies JobProgressEvent);

      // 6. Record Intent Cards in database for web workstation review
      const intentCardInputs = transcreateRes.intentCards.map(c => ({
        sectionIndex: c.sectionIndex,
        codeBlockIndex: c.codeBlockIndex,
        originalMetaphor: c.originalMetaphor,
        targetMetaphor: c.targetMetaphor,
        mismatchReason: c.mismatchReason,
        rationale: c.rationale,
        culturalContext: c.culturalContext,
        confidence: c.confidence,
        alternatives: c.alternatives.map(a => ({
          id: a.id,
          metaphor: a.metaphor,
          rationale: a.rationale,
          suggestedText: a.suggestedText,
          isNeutralTechnical: a.isNeutralTechnical ?? false
        }))
      }));

      await this.repo.saveIntentCards(tenantContext, jobId, intentCardInputs);

      // 7. Stage 4: Create new transcreated document version (90%)
      await this.repo.updateJobStatus(tenantContext, jobId, { progressPercent: 90 });
      this.queue.emit("progress", {
        jobId,
        orgId: tenantContext.orgId,
        progressPercent: 90,
        stage: "RECORDING_VERSION",
        status: "processing"
      } satisfies JobProgressEvent);

      const newVersion = await this.repo.createDocumentVersion(tenantContext, {
        documentId,
        versionNumber: versions.length + 1,
        contentHash: "hash_" + Date.now(),
        content: transcreateRes.transcreatedMarkdown,
        createdBy: tenantContext.userId
      });

      // 8. Stage 5: Finalize Job as Completed (100%)
      await this.repo.updateJobStatus(tenantContext, jobId, {
        status: "completed",
        progressPercent: 100,
        completedAt: new Date(),
        modelUsed: options?.model || "default",
        promptTokens: transcreateRes.stats.proseNodesTranscreated * 15,
        completionTokens: transcreateRes.stats.codeBlocksValidated * 25,
        estimatedCostCents: Number((0.02 * transcreateRes.stats.metaphorsTranscreated).toFixed(4))
      });

      this.queue.markCompleted(jobId);
      this.queue.emit("progress", {
        jobId,
        orgId: tenantContext.orgId,
        progressPercent: 100,
        stage: "COMPLETED",
        status: "completed"
      } satisfies JobProgressEvent);

      return newVersion;
    } catch (err: any) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await this.repo.updateJobStatus(tenantContext, jobId, {
        status: "failed",
        errorMessage: errorMsg,
        updatedAt: new Date()
      });

      await this.repo.logAudit(tenantContext, "job.failed", "job", jobId, {
        error: errorMsg
      });

      this.queue.markFailed(jobId, err instanceof Error ? err : new Error(errorMsg));
      throw err;
    }
  }

  /**
   * Run one step from the queue if available.
   */
  public async pollAndProcess(): Promise<DocumentVersion | null> {
    const job = this.queue.getNextJob();
    if (!job) return null;
    return await this.processJob(job);
  }
}
