import { describe, it, expect } from "vitest";
import { CodeValidator } from "../src/sandbox/validator.js";
import type { CodeBlockSlice, ProseNodeSlice } from "../types.js";

describe("CodeValidator", () => {
  const validator = new CodeValidator();

  it("passes valid code immediately", async () => {
    const block: CodeBlockSlice = {
      index: 0,
      lang: "typescript",
      startOffset: 0,
      endOffset: 10,
      originalCode: "const x: number = 42;",
      candidateSymbols: [],
      associatedSectionIndices: [0]
    };

    const prose: ProseNodeSlice[] = [
      {
        index: 0,
        type: "paragraph",
        startOffset: 0,
        endOffset: 10,
        originalText: "Hello world",
        maskedText: "Hello world",
        urlMap: {},
        inlineCodeTokens: [],
        localizedText: "こんにちは世界"
      }
    ];

    const result = await validator.validateAndHeal(block, prose);
    expect(result.healed).toBe(false);
    expect(result.rolledBack).toBe(false);
    expect(block.syntaxValid).toBe(true);
    expect(prose[0].localizedText).toBe("こんにちは世界");
  });

  it("heals invalid code using 1-shot repair function", async () => {
    const block: CodeBlockSlice = {
      index: 0,
      lang: "typescript",
      startOffset: 0,
      endOffset: 10,
      originalCode: "const valid = 1;",
      transformedCode: "const broken = ;", // syntax error
      candidateSymbols: [],
      associatedSectionIndices: [0]
    };

    const prose: ProseNodeSlice[] = [];

    const repairFn = async () => "const repaired = 1;";

    const result = await validator.validateAndHeal(block, prose, repairFn);
    expect(result.healed).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(block.transformedCode).toBe("const repaired = 1;");
    expect(block.syntaxValid).toBe(true);
  });

  it("triggers correlated rollback on both code and prose when repair fails", async () => {
    const block: CodeBlockSlice = {
      index: 0,
      lang: "typescript",
      startOffset: 0,
      endOffset: 10,
      originalCode: "const original = 10;",
      transformedCode: "class Invalid { broken syntax [",
      candidateSymbols: [],
      associatedSectionIndices: [0]
    };

    const prose: ProseNodeSlice[] = [
      {
        index: 0,
        type: "paragraph",
        startOffset: 0,
        endOffset: 10,
        originalText: "Original English paragraph.",
        maskedText: "Original English paragraph.",
        urlMap: {},
        inlineCodeTokens: [],
        localizedText: "Translated text that should rollback."
      }
    ];

    // Repair function that still produces invalid code
    const failingRepair = async () => "still invalid [ syntax";

    const result = await validator.validateAndHeal(block, prose, failingRepair);
    expect(result.healed).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(block.flaggedForHumanReview).toBe(true);
    expect(block.transformedCode).toBe("const original = 10;");
    // Prose section is correlated and rolled back to original English
    expect(prose[0].localizedText).toBe("Original English paragraph.");
  });
});
