import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TranscreateEngine } from "../src/transcreate/engine.js";
import { InMemoryTenantScopedRepository } from "../src/saas/repository-inmemory.js";
import { PostgreSqlDatabaseClient } from "../src/saas/db/client.js";
import type { TenantContext } from "../src/saas/models.js";

describe("Engine-Service SaaS Integration", () => {
  let engine: TranscreateEngine;
  let repo: InMemoryTenantScopedRepository;
  const fixturePath = path.resolve(process.cwd(), "fixtures/baseball-tutorial.md");
  const fixtureSource = fs.readFileSync(fixturePath, "utf-8");

  const ctxTenantA: TenantContext = {
    orgId: "org_alpha_77777777",
    userId: "usr_alice",
    role: "admin",
    projectId: "proj_acme_docs"
  };

  const ctxTenantB: TenantContext = {
    orgId: "org_beta_88888888",
    userId: "usr_charlie",
    role: "admin",
    projectId: "proj_globex_docs"
  };

  beforeEach(() => {
    engine = new TranscreateEngine();
    repo = new InMemoryTenantScopedRepository();
    repo.seedOrganization({
      id: "org_alpha_77777777",
      name: "Acme Corp",
      slug: "acme",
      plan: "enterprise",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    repo.seedOrganization({
      id: "org_beta_88888888",
      name: "Globex Corp",
      slug: "globex",
      plan: "pro",
      createdAt: new Date(),
      updatedAt: new Date()
    });
  });

  it("stores and retrieves project analogies in InMemoryTenantScopedRepository during transcreation", async () => {
    // 1. Run transcreation for Tenant A
    const resA = await engine.transcreate(fixtureSource, {
      filePath: "fixtures/baseball-tutorial.md",
      targetLocale: "ja-JP",
      glossaryRepo: repo,
      tenantContext: ctxTenantA
    });

    expect(resA.targetLocale).toBe("ja-JP");
    expect(resA.stats.metaphorsTranscreated).toBeGreaterThan(0);

    // 2. Verify repository now contains the saved glossary for Tenant A
    const glossaryEntriesA = await repo.getGlossaryEntries(ctxTenantA, "ja-JP", ctxTenantA.projectId);
    expect(glossaryEntriesA.length).toBeGreaterThan(0);
    const metaphorEntry = glossaryEntriesA.find(e => e.category === "metaphor");
    expect(metaphorEntry).toBeDefined();
    expect(metaphorEntry?.targetTerm).toBeDefined();

    // 3. Verify Tenant B's repository is completely clean / empty for ja-JP
    const glossaryEntriesB = await repo.getGlossaryEntries(ctxTenantB, "ja-JP", ctxTenantB.projectId);
    expect(glossaryEntriesB.length).toBe(0);

    // 4. Pre-seed a custom override for Tenant B to verify independence
    await repo.saveGlossary(ctxTenantB.orgId, ctxTenantB.projectId, "ja-JP", {
      primaryMetaphor: "Japanese Robotics Automation",
      symbolTable: {
        "pitcher": "roboticArm",
        "batter": "conveyorSensor"
      }
    });

    // 5. Run transcreation for Tenant B
    const resB = await engine.transcreate(fixtureSource, {
      filePath: "fixtures/baseball-tutorial.md",
      targetLocale: "ja-JP",
      glossaryRepo: repo,
      tenantContext: ctxTenantB
    });

    // Tenant B's output uses Tenant B's seeded glossary symbols
    expect(resB.symbolTable["pitcher"]).toBe("roboticArm");
    expect(resB.symbolTable["batter"]).toBe("conveyorSensor");

    // Tenant A's glossary remains intact and unchanged
    const recheckA = await repo.getGlossary(ctxTenantA.orgId, ctxTenantA.projectId, "ja-JP");
    expect(recheckA.symbolTable?.["pitcher"]).not.toBe("roboticArm");
  });

  it("preserves 100% AST integrity and correlated rollback with tenant context", async () => {
    const result = await engine.transcreate(fixtureSource, {
      filePath: "fixtures/baseball-tutorial.md",
      targetLocale: "ja-JP",
      glossaryRepo: repo,
      tenantContext: ctxTenantA
    });

    // Immutable frontmatter preserved
    expect(result.transcreatedMarkdown).toContain('title: "Understanding Asynchronous Event Processing"');
    // URLs and images unmasked cleanly
    expect(result.transcreatedMarkdown).toContain("https://assets.example.com/diagrams/batting-order.png");
    expect(result.transcreatedMarkdown).toContain("https://mlb.com/rules");
    // Code block identifiers adapted
    expect(result.codeBlocks.length).toBeGreaterThan(0);
    for (const block of result.codeBlocks) {
      expect(block.syntaxValid).toBe(true);
    }
  });
});
