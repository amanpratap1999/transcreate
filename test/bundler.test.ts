import { describe, it, expect } from "vitest";
import { WorkstationBundler } from "../src/viewer/bundler.js";
import type { TranscreateResult } from "../types.js";

describe("WorkstationBundler", () => {
  const bundler = new WorkstationBundler();

  const mockResult: TranscreateResult = {
    filePath: "test.md",
    targetLocale: "ja-JP",
    originalMarkdown: "# Original Title\n\nSome paragraph.",
    transcreatedMarkdown: "# Localized Title\n\nSome translated paragraph.",
    intentCards: [
      {
        id: "test-1",
        sectionIndex: 0,
        associatedSymbols: ["batterQueue"],
        originalMetaphor: "Baseball",
        targetMetaphor: "Shinkansen",
        mismatchReason: "Sports idiom mismatch",
        rationale: "Transit system analogy",
        culturalContext: "Japanese developer expectations",
        confidence: 0.95,
        alternatives: [
          {
            id: "alt-1",
            metaphor: "Neutral Technical",
            rationale: "Clean direct explanation",
            suggestedText: "FIFO Queue buffer",
            isNeutralTechnical: true
          }
        ]
      }
    ],
    symbolTable: { batterQueue: "passengerQueue" },
    codeBlocks: [],
    proseNodes: [
      {
        index: 0,
        type: "paragraph",
        startOffset: 0,
        endOffset: 16,
        originalText: "Original Title",
        maskedText: "Original Title",
        urlMap: {},
        inlineCodeTokens: [],
        localizedText: "Localized Title",
        accepted: true
      }
    ],
    htmlViewerPath: "",
    stats: {
      metaphorsTranscreated: 1,
      codeIdentifiersAdapted: 1,
      codeBlocksValidated: 0,
      proseNodesTranscreated: 1
    }
  };

  it("generates a completely self-contained single-file HTML without external CDN links", () => {
    const html = bundler.generateHtml(mockResult);

    // Verify zero CDN links
    expect(html).not.toMatch(/<script\s+[^>]*src=["']https?:\/\//i);
    expect(html).not.toMatch(/<link\s+[^>]*href=["']https?:\/\//i);

    // Verify presence of view modes
    expect(html).toContain("Split View");
    expect(html).toContain("Unified Diff");
    expect(html).toContain("Rendered Article");

    // Verify Intent drawer and neutral fallback
    expect(html).toContain("Intent Drawer");
    expect(html).toContain("Neutral Technical");

    // Verify Export functionality
    expect(html).toContain("Export Markdown");
  });
});
