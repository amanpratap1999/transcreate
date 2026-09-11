import { InMemoryTenantScopedRepository } from "../src/saas/repository-inmemory.js";
import { PostgreSqlDatabaseClient } from "../src/saas/db/client.js";
import { describe, it, expect, beforeEach } from "vitest";
import {
    TenantAccessDeniedError,
  RolePermissionError
} from "../src/saas/repository.js";
import type { TenantContext } from "../src/saas/models.js";

describe("SaaS Multi-Tenancy & Tenant Isolation Security Gates", () => {
  let repo: InMemoryTenantScopedRepository;

  // Tenant A: Acme Corp
  const ctxTenantA_Admin: TenantContext = {
    orgId: "org_alpha_11111111",
    userId: "usr_alice_admin",
    role: "admin"
  };

  const ctxTenantA_Viewer: TenantContext = {
    orgId: "org_alpha_11111111",
    userId: "usr_bob_viewer",
    role: "viewer"
  };

  // Tenant B: Globex Inc
  const ctxTenantB_Admin: TenantContext = {
    orgId: "org_beta_22222222",
    userId: "usr_charlie_admin",
    role: "admin"
  };

  const ctxTenantB_Editor: TenantContext = {
    orgId: "org_beta_22222222",
    userId: "usr_david_editor",
    role: "editor"
  };

  beforeEach(() => {
    repo = new InMemoryTenantScopedRepository();
    // Seed organizations
    repo.seedOrganization({
      id: "org_alpha_11111111",
      name: "Acme Corp",
      slug: "acme-corp",
      plan: "enterprise",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    repo.seedOrganization({
      id: "org_beta_22222222",
      name: "Globex Inc",
      slug: "globex-inc",
      plan: "pro",
      createdAt: new Date(),
      updatedAt: new Date()
    });
  });

  describe("1. Organization & Project Isolation", () => {
    it("prevents Tenant B from viewing or listing Tenant A projects", async () => {
      // Tenant A creates project
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Acme Cloud Docs",
        slug: "acme-cloud-docs",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP", "de-DE"]
      });

      expect(projA.orgId).toBe(ctxTenantA_Admin.orgId);

      // Tenant A lists projects -> sees Acme Cloud Docs
      const listA = await repo.listProjects(ctxTenantA_Admin);
      expect(listA.length).toBe(1);
      expect(listA[0].id).toBe(projA.id);

      // Tenant B lists projects -> sees 0 projects
      const listB = await repo.listProjects(ctxTenantB_Admin);
      expect(listB.length).toBe(0);

      // Tenant B attempts direct access to Tenant A's project ID -> Access Denied
      await expect(
        repo.getProject(ctxTenantB_Admin, projA.id)
      ).rejects.toThrow(TenantAccessDeniedError);
    });

    it("prevents Tenant B from mutating or deleting Tenant A projects", async () => {
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Acme Internal API",
        slug: "acme-internal-api",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP"]
      });

      // Tenant B attempts update
      await expect(
        repo.updateProject(ctxTenantB_Admin, projA.id, { name: "Hacked Project" })
      ).rejects.toThrow(TenantAccessDeniedError);

      // Verify name was NOT changed
      const verifiedProjA = await repo.getProject(ctxTenantA_Admin, projA.id);
      expect(verifiedProjA.name).toBe("Acme Internal API");

      // Tenant B attempts deletion
      await expect(
        repo.deleteProject(ctxTenantB_Admin, projA.id)
      ).rejects.toThrow(TenantAccessDeniedError);

      // Verify project still exists for Tenant A
      const aliveProj = await repo.getProject(ctxTenantA_Admin, projA.id);
      expect(aliveProj.id).toBe(projA.id);
    });
  });

  describe("2. Document & Version Isolation", () => {
    it("enforces strict boundary on document creation, reading, and versioning", async () => {
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Project A",
        slug: "project-a",
        sourceLocale: "en-US",
        targetLocales: ["fr-FR"]
      });

      const docA = await repo.createDocument(ctxTenantA_Admin, {
        projectId: projA.id,
        filePath: "tutorials/architecture.md",
        title: "System Architecture"
      });

      // Tenant B tries to read Document A
      await expect(
        repo.getDocument(ctxTenantB_Admin, docA.id)
      ).rejects.toThrow(TenantAccessDeniedError);

      // Tenant B tries to list documents for Project A
      await expect(
        repo.listDocuments(ctxTenantB_Admin, projA.id)
      ).rejects.toThrow(TenantAccessDeniedError);

      // Tenant B tries to create a version under Tenant A's document
      await expect(
        repo.createDocumentVersion(ctxTenantB_Admin, {
          documentId: docA.id,
          versionNumber: 1,
          contentHash: "sha256_fake_hash",
          content: "# Malicious injection"
        })
      ).rejects.toThrow(TenantAccessDeniedError);
    });
  });

  describe("3. Job Idempotency & Tenant Scoping", () => {
    it("preserves idempotency within the same tenant, prevents leakage across tenants", async () => {
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Acme Sync",
        slug: "acme-sync",
        sourceLocale: "en-US",
        targetLocales: ["es-ES"]
      });

      const docA = await repo.createDocument(ctxTenantA_Admin, {
        projectId: projA.id,
        filePath: "intro.md",
        title: "Intro"
      });

      const versionA = await repo.createDocumentVersion(ctxTenantA_Admin, {
        documentId: docA.id,
        versionNumber: 1,
        contentHash: "hash_intro_v1",
        content: "# Welcome to Acme"
      });

      const sharedIdempotencyKey = "transcreate_intro_v1_es-ES";

      // Tenant A creates job
      const jobA1 = await repo.createJob(ctxTenantA_Admin, {
        documentVersionId: versionA.id,
        targetLocale: "es-ES",
        idempotencyKey: sharedIdempotencyKey,
        status: "pending"
      });

      // Tenant A submits again with same idempotency key -> returns existing job
      const jobA2 = await repo.createJob(ctxTenantA_Admin, {
        documentVersionId: versionA.id,
        targetLocale: "es-ES",
        idempotencyKey: sharedIdempotencyKey,
        status: "pending"
      });

      expect(jobA2.id).toBe(jobA1.id);

      // Now Tenant B creates their own project, document, version
      const projB = await repo.createProject(ctxTenantB_Admin, {
        name: "Globex Docs",
        slug: "globex-docs",
        sourceLocale: "en-US",
        targetLocales: ["es-ES"]
      });

      const docB = await repo.createDocument(ctxTenantB_Admin, {
        projectId: projB.id,
        filePath: "intro.md",
        title: "Globex Intro"
      });

      const versionB = await repo.createDocumentVersion(ctxTenantB_Admin, {
        documentId: docB.id,
        versionNumber: 1,
        contentHash: "hash_globex_v1",
        content: "# Welcome to Globex"
      });

      // Tenant B submits job with the EXACT SAME idempotency key
      const jobB = await repo.createJob(ctxTenantB_Admin, {
        documentVersionId: versionB.id,
        targetLocale: "es-ES",
        idempotencyKey: sharedIdempotencyKey,
        status: "pending"
      });

      // Tenant B receives their own separate job, NOT Tenant A's job
      expect(jobB.id).not.toBe(jobA1.id);
      expect(jobB.orgId).toBe(ctxTenantB_Admin.orgId);

      // Tenant B cannot access Tenant A's job
      await expect(
        repo.getJob(ctxTenantB_Admin, jobA1.id)
      ).rejects.toThrow(TenantAccessDeniedError);
    });
  });

  describe("4. Project Analogy Memory (Glossary) Isolation", () => {
    it("guarantees Tenant A's cultural analogies never leak to Tenant B", async () => {
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Acme Product",
        slug: "acme-prod",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP"]
      });

      const projB = await repo.createProject(ctxTenantB_Admin, {
        name: "Globex Product",
        slug: "globex-prod",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP"]
      });

      // Tenant A stores custom analogy mapping
      await repo.saveGlossary(ctxTenantA_Admin.orgId, projA.id, "ja-JP", {
        primaryMetaphor: "Kabuki Theatre",
        symbolTable: {
          "touchdown": "ippon",
          "quarterback": "tateyaku"
        }
      });

      // Tenant A loads glossary -> finds stored analogies
      const glossaryA = await repo.loadGlossary(ctxTenantA_Admin.orgId, projA.id, "ja-JP");
      expect(glossaryA["ja-JP"]?.primaryMetaphor).toBe("Kabuki Theatre");
      expect(glossaryA["ja-JP"]?.symbolTable["touchdown"]).toBe("ippon");

      // Tenant B loads glossary for ja-JP -> receives EMPTY or default, NEVER Tenant A's
      const glossaryB = await repo.loadGlossary(ctxTenantB_Admin.orgId, projB.id, "ja-JP");
      expect(glossaryB["ja-JP"]).toBeUndefined();

      // Tenant B attempts to save glossary to Tenant A's project directly -> Access Denied
      await expect(
        repo.saveGlossary(ctxTenantB_Admin.orgId, projA.id, "ja-JP", {
          primaryMetaphor: "Malicious Metaphor",
          symbolTable: { "touchdown": "hijack" }
        })
      ).rejects.toThrow(TenantAccessDeniedError);

      // Verify Tenant A's glossary remains uncompromised
      const intactGlossaryA = await repo.loadGlossary(ctxTenantA_Admin.orgId, projA.id, "ja-JP");
      expect(intactGlossaryA["ja-JP"]?.primaryMetaphor).toBe("Kabuki Theatre");
    });
  });

  describe("5. Role-Based Access Control (RBAC)", () => {
    it("enforces least privilege: viewers cannot create or mutate resources", async () => {
      // Viewer attempts to create a project
      await expect(
        repo.createProject(ctxTenantA_Viewer, {
          name: "Unauthorized Project",
          slug: "unauthorized-project",
          sourceLocale: "en-US",
          targetLocales: ["ja-JP"]
        })
      ).rejects.toThrow(RolePermissionError);

      // Admin creates project
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Legit Project",
        slug: "legit-project",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP"]
      });

      // Viewer CAN read the project
      const readProj = await repo.getProject(ctxTenantA_Viewer, projA.id);
      expect(readProj.id).toBe(projA.id);

      // Viewer CANNOT update the project
      await expect(
        repo.updateProject(ctxTenantA_Viewer, projA.id, { name: "Tampered" })
      ).rejects.toThrow(RolePermissionError);

      // Viewer CANNOT create documents
      await expect(
        repo.createDocument(ctxTenantA_Viewer, {
          projectId: projA.id,
          filePath: "guide.md",
          title: "Guide"
        })
      ).rejects.toThrow(RolePermissionError);
    });

    it("allows editor role to create and transcreate, but restricts admin management", async () => {
      const projB = await repo.createProject(ctxTenantB_Admin, {
        name: "Globex Cloud",
        slug: "globex-cloud",
        sourceLocale: "en-US",
        targetLocales: ["de-DE"]
      });

      // Editor CAN create document
      const doc = await repo.createDocument(ctxTenantB_Editor, {
        projectId: projB.id,
        filePath: "quickstart.md",
        title: "Quickstart"
      });
      expect(doc.id).toBeDefined();

      // Editor CAN create document version
      const ver = await repo.createDocumentVersion(ctxTenantB_Editor, {
        documentId: doc.id,
        versionNumber: 1,
        contentHash: "hash_qs_v1",
        content: "# Quickstart Guide"
      });
      expect(ver.id).toBeDefined();

      // Editor CAN trigger a transcreation job
      const job = await repo.createJob(ctxTenantB_Editor, {
        documentVersionId: ver.id,
        targetLocale: "de-DE",
        idempotencyKey: "job_qs_v1_de",
        status: "pending"
      });
      expect(job.id).toBeDefined();

      // Editor CANNOT delete the project (requires admin)
      await expect(
        repo.deleteProject(ctxTenantB_Editor, projB.id)
      ).rejects.toThrow(RolePermissionError);
    });
  });

  describe("6. Audit Logging Boundary & Zero Leakage", () => {
    it("ensures every action is recorded and audit logs are strictly tenant-isolated", async () => {
      const projA = await repo.createProject(ctxTenantA_Admin, {
        name: "Acme Audit Test",
        slug: "acme-audit",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP"]
      });

      const projB = await repo.createProject(ctxTenantB_Admin, {
        name: "Globex Audit Test",
        slug: "globex-audit",
        sourceLocale: "en-US",
        targetLocales: ["ja-JP"]
      });

      const logsA = await repo.getAuditLogs(ctxTenantA_Admin);
      const logsB = await repo.getAuditLogs(ctxTenantB_Admin);

      // Verify logs exist for both tenants
      expect(logsA.length).toBeGreaterThan(0);
      expect(logsB.length).toBeGreaterThan(0);

      // Verify Tenant A logs contain only Tenant A's orgId and resources
      for (const log of logsA) {
        expect(log.orgId).toBe(ctxTenantA_Admin.orgId);
        expect(log.userId).toBe(ctxTenantA_Admin.userId);
        expect(log.resourceId).not.toBe(projB.id);
      }

      // Verify Tenant B logs contain only Tenant B's orgId and resources
      for (const log of logsB) {
        expect(log.orgId).toBe(ctxTenantB_Admin.orgId);
        expect(log.userId).toBe(ctxTenantB_Admin.userId);
        expect(log.resourceId).not.toBe(projA.id);
      }

      // Viewer role cannot view audit logs (requires admin)
      await expect(
        repo.getAuditLogs(ctxTenantA_Viewer)
      ).rejects.toThrow(RolePermissionError);
    });
  });
});
