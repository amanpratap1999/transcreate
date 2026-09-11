import { PostgreSqlDatabaseClient } from "../src/saas/db/client.js";
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { TranscreateEngine } from "../src/transcreate/engine.js";
import { WorkstationBundler } from "../src/viewer/bundler.js";
import { BabelAdapter } from "../src/parser/code.js";

describe("End-to-End Transcreation Pipeline", () => {
  const engine = new TranscreateEngine();
  const bundler = new WorkstationBundler();
  const adapter = new BabelAdapter();
  const fixturePath = path.resolve(process.cwd(), "fixtures/baseball-tutorial.md");
  const fixtureSource = fs.readFileSync(fixturePath, "utf-8");

  it("transcreates baseball tutorial to Japanese (ja-JP) with full AST safety", async () => {
    const result = await engine.transcreate(fixtureSource, {
      filePath: "fixtures/baseball-tutorial.md",
      targetLocale: "ja-JP"
    });

    // 1. Frontmatter check: Title and YAML metadata preserved
    expect(result.transcreatedMarkdown).toContain('title: "Understanding Asynchronous Event Processing"');
    expect(result.transcreatedMarkdown).toContain('author: "DevRel Team"');

    // 2. URLs and Images preserved byte-for-byte
    expect(result.transcreatedMarkdown).toContain("https://mlb.com/rules");
    expect(result.transcreatedMarkdown).toContain("https://internal.example.com/docs/architecture");
    expect(result.transcreatedMarkdown).toContain("https://assets.example.com/diagrams/batting-order.png");

    // 3. MDX Callout preserved
    expect(result.transcreatedMarkdown).toContain('<Callout type="info">');

    // 4. Code Block Adaptation
    expect(result.transcreatedMarkdown).toContain("export class TrainDispatchProcessor");
    expect(result.transcreatedMarkdown).toContain("private passengerQueue: PassengerRequest[] = [];");
    expect(result.transcreatedMarkdown).toContain("private cancelTicket(batter: PassengerRequest): void");

    // 5. Code Syntax Validation
    const codeBlockMatch = result.transcreatedMarkdown.match(/```typescript([\s\S]*?)```/);
    expect(codeBlockMatch).toBeTruthy();
    const adaptedCode = codeBlockMatch![1];
    const validation = adapter.validateSyntax(adaptedCode);
    expect(validation.valid).toBe(true);

    // 6. Inline Code Backtick Synchronization
    expect(result.transcreatedMarkdown).toContain("`passengerQueue`");
    expect(result.transcreatedMarkdown).toContain("`cancelTicket()`");

    // 7. Intent Cards and Neutral Fallback
    expect(result.intentCards.length).toBeGreaterThan(0);
    const primaryCard = result.intentCards[0];
    expect(primaryCard.originalMetaphor).toContain("Baseball");
    expect(primaryCard.targetMetaphor).toContain("Shinkansen");

    const neutralAlt = primaryCard.alternatives.find(a => a.isNeutralTechnical);
    expect(neutralAlt).toBeDefined();
    expect(neutralAlt?.metaphor).toContain("Neutral Technical");

    // 8. Workstation HTML Generation
    const html = bundler.generateHtml(result);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Split View");
    expect(html).toContain("Unified Diff");
    expect(html).toContain("Rendered Article");
  });

  it("transcreates baseball tutorial to Hindi (hi-IN) with Tatkal railway reservation model", async () => {
    const result = await engine.transcreate(fixtureSource, {
      filePath: "fixtures/baseball-tutorial.md",
      targetLocale: "hi-IN"
    });

    expect(result.transcreatedMarkdown).toContain("export class TatkalQueueProcessor");
    expect(result.transcreatedMarkdown).toContain("private bookingQueue: PassengerRequest[] = [];");
    expect(result.transcreatedMarkdown).toContain("`bookingQueue`");
  });
});
