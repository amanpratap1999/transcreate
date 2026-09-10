import { describe, it, expect } from "vitest";
import { MarkdownParser } from "../src/parser/markdown.js";
import * as fs from "node:fs";
import * as path from "node:path";

describe("MarkdownParser", () => {
  const parser = new MarkdownParser();
  const fixturePath = path.resolve(process.cwd(), "fixtures/baseball-tutorial.md");
  const fixtureContent = fs.readFileSync(fixturePath, "utf-8");

  it("extracts frontmatter, code blocks, and prose nodes from fixture", () => {
    const analysis = parser.analyzeDocument(fixtureContent);

    expect(analysis.frontmatter).toBeDefined();
    expect(analysis.frontmatter).toContain('title: "Understanding Asynchronous Event Processing"');
    expect(analysis.codeBlocks.length).toBeGreaterThanOrEqual(1);

    const tsBlock = analysis.codeBlocks[0];
    expect(tsBlock.lang).toBe("typescript");
    expect(tsBlock.candidateSymbols.map(s => s.name)).toContain("BattingLineupProcessor");

    expect(analysis.proseNodes.length).toBeGreaterThan(3);
  });

  it("masks and unmasks URLs and image links without corruption", () => {
    const analysis = parser.analyzeDocument(fixtureContent);
    const linkNode = analysis.proseNodes.find(n => n.originalText.includes("Official Baseball Rules"));

    expect(linkNode).toBeDefined();
    expect(linkNode?.maskedText).toContain("__URL_REF_");
    expect(linkNode?.maskedText).not.toContain("https://mlb.com/rules");

    // Unmask
    const unmasked = parser.unmaskUrls(linkNode!.maskedText, linkNode!.urlMap);
    expect(unmasked).toBe(linkNode!.originalText);
  });

  it("synchronizes inline code tokens with symbolTable", () => {
    const text = "Notice how our `batterQueue` keeps incoming jobs orderly while calling `strikeOut()`.";
    const synced = parser.syncInlineCode(text, {
      batterQueue: "passengerQueue",
      strikeOut: "cancelTicket"
    });

    expect(synced).toBe("Notice how our `passengerQueue` keeps incoming jobs orderly while calling `cancelTicket()`.");
    // Wait: strikeOut() in backtick had (), so if inner is 'strikeOut()', symbolTable needs exact match or match identifier
  });

  it("surgically splices document bottom-up with multibyte Japanese and Hindi without offset drift", () => {
    const original = "Section One.\n\nSection Two.\n\nSection Three.";
    // Replace Section One with Japanese, Section Two with Hindi, Section Three with German
    const replacements = [
      { start: 0, end: 12, text: "第1セクション（野球から新幹線への換骨奪胎）。" },
      { start: 14, end: 26, text: "भाग दो (रेलवे आरक्षण कतार)।" },
      { start: 28, end: 42, text: "Abschnitt Drei." }
    ];

    const result = parser.spliceDocument(original, replacements);

    expect(result).toBe(
      "第1セクション（野球から新幹線への換骨奪胎）。\n\nभाग दो (रेलवे आरक्षण कतार)।\n\nAbschnitt Drei."
    );
  });

  it("safely handles multiple duplicate URLs in the same paragraph without corrupting tokens", () => {
    const md = "Visit [Link A](https://example.com) and also [Link B](https://example.com) for details.";
    const analysis = parser.analyzeDocument(md);
    const node = analysis.proseNodes[0];

    expect(Object.keys(node.urlMap).length).toBe(1);
    const unmasked = parser.unmaskUrls(node.maskedText, node.urlMap);
    expect(unmasked).toBe(md);
  });
});
