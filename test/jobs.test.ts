import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { JobQueue, AsyncJobWorker, type JobProgressEvent } from "../src/saas/jobs.js";
import { InMemoryTenantScopedRepository } from "../src/saas/repository-inmemory.js";
import { PostgreSqlDatabaseClient } from "../src/saas/db/client.js";
import { TranscreateEngine } from "../src/transcreate/engine.js";
import type { TenantContext } from "../src/saas/models.js";

describe("SaaS Asynchronous Background Job System & Worker Pool", () => {
  let queue: JobQueue;
  let repo: InMemoryTenantScopedRepository;
  let engine: TranscreateEngine;
  let worker: AsyncJobWorker;

  const fixturePath = path.resolve(process.cwd(), "fixtures/baseball-tutorial.md");
  const fixtureSource = fs.readFileSync(fixturePath, "utf-8");

  const ctxTenantA: TenantContext = {
    orgId: "org_alpha_jobs",
    userId: "usr_alice",
    role: "admin",
    projectId: "proj_cloud_docs"
  };

  beforeEach(() => {
    queue = new JobQueue(2);
    repo = new InMemoryTenantScopedRepository();
    engine = new TranscreateEngine();
    worker = new AsyncJobWorker(repo, engine, queue);

    repo.seedOrganization({
      id: "org_alpha_jobs",
      name: "Acme Jobs",
      slug: "acme-jobs",
      plan: "enterprise",
      createdAt: new Date(),
      updatedAt: new Date()
    });
  });

  it("orchestrates asynchronous transcreation job through all stages to completion", async () => {
    // 1. Create project, document, version in repository
    const project = await repo.createProject(ctxTenantA, {
      name: "Queue Docs",
      slug: "queue-docs",
      sourceLocale: "en-US",
      targetLocales: ["ja-JP"]
    });

    const doc = await repo.createDocument(ctxTenantA, {
      projectId: project.id,
      filePath: "guides/baseball-async.md",
      title: "Async Baseball Guide"
    });

    const version1 = await repo.createDocumentVersion(ctxTenantA, {
      documentId: doc.id,
      versionNumber: 1,
      contentHash: "hash_v1",
      content: fixtureSource,
      createdBy: ctxTenantA.userId
    });

    // 2. Create Job in database
    const dbJob = await repo.createJob(ctxTenantA, {
      documentVersionId: version1.id,
      targetLocale: "ja-JP",
      idempotencyKey: "job_async_001",
      status: "pending"
    });

    // 3. Track progress events emitted by queue
    const progressEvents: JobProgressEvent[] = [];
    queue.on("progress", (ev: JobProgressEvent) => {
      progressEvents.push(ev);
    });

    // 4. Enqueue job
    queue.enqueue({
      jobId: dbJob.id,
      tenantContext: { ...ctxTenantA, projectId: project.id },
      documentId: doc.id,
      documentVersionId: version1.id,
      targetLocale: "ja-JP"
    });

    expect(queue.getQueueLength()).toBe(1);

    // 5. Worker processes job
    const newVersion = await worker.pollAndProcess();
    expect(newVersion).not.toBeNull();
    expect(newVersion?.versionNumber).toBe(2);
    expect(newVersion?.content).toContain('title: "Understanding Asynchronous Event Processing"');
    expect(newVersion?.content).toContain("passengerQueue");

    // 6. Verify Job status updated to completed in DB
    const finishedJob = await repo.getJob(ctxTenantA, dbJob.id);
    expect(finishedJob.status).toBe("completed");
    expect(finishedJob.progressPercent).toBe(100);
    expect(finishedJob.completedAt).toBeDefined();

    // 7. Verify all stage events occurred sequentially
    const stages = progressEvents.map(e => e.stage);
    expect(stages).toContain("FETCHING_SOURCE");
    expect(stages).toContain("AST_PARSING");
    expect(stages).toContain("VALIDATING_AND_SPLICING");
    expect(stages).toContain("RECORDING_VERSION");
    expect(stages).toContain("COMPLETED");

    // 8. Verify Intent Cards were extracted and stored
    const intentCards = await repo.getIntentCards(ctxTenantA, dbJob.id);
    expect(intentCards.length).toBeGreaterThan(0);
    expect(intentCards[0].originalMetaphor).toContain("Baseball");
    expect(intentCards[0].targetMetaphor).toBeDefined();
    expect(intentCards[0].alternatives.length).toBeGreaterThan(0);
  });

  it("handles worker failure, retries up to maxRetries, and routes to DLQ on terminal failure", async () => {
    const project = await repo.createProject(ctxTenantA, {
      name: "Fail Test",
      slug: "fail-test",
      sourceLocale: "en-US",
      targetLocales: ["ja-JP"]
    });

    const doc = await repo.createDocument(ctxTenantA, {
      projectId: project.id,
      filePath: "nonexistent.md"
    });

    // Create job pointing to a non-existent version ID to force failure
    const dbJob = await repo.createJob(ctxTenantA, {
      documentVersionId: "invalid_version_999",
      targetLocale: "ja-JP",
      idempotencyKey: "job_fail_001",
      status: "pending"
    });

    const retryEvents: any[] = [];
    const dlqEvents: any[] = [];

    queue.on("retrying", e => retryEvents.push(e));
    queue.on("failed_dlq", e => dlqEvents.push(e));

    queue.enqueue({
      jobId: dbJob.id,
      tenantContext: { ...ctxTenantA, projectId: project.id },
      documentId: doc.id,
      documentVersionId: "invalid_version_999",
      targetLocale: "ja-JP",
      maxRetries: 2
    });

    // First attempt -> fails -> retries
    await expect(worker.pollAndProcess()).rejects.toThrow("not found");
    expect(retryEvents.length).toBe(1);

    // Second attempt -> fails -> retries
    await expect(worker.pollAndProcess()).rejects.toThrow("not found");
    expect(retryEvents.length).toBe(2);

    // Third attempt -> exceeds maxRetries (2) -> routes to DLQ
    await expect(worker.pollAndProcess()).rejects.toThrow("not found");
    expect(dlqEvents.length).toBe(1);
    expect(queue.getDLQ().length).toBe(1);

    // Verify job in DB is marked as failed
    const failedJob = await repo.getJob(ctxTenantA, dbJob.id);
    expect(failedJob.status).toBe("failed");
    expect(failedJob.errorMessage).toContain("not found");
  });
});
