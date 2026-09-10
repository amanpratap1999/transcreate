import { describe, it, expect } from "vitest";
import { BabelAdapter } from "../src/parser/code.js";

describe("BabelAdapter", () => {
  const adapter = new BabelAdapter();

  it("identifies supported languages", () => {
    expect(adapter.supports("ts")).toBe(true);
    expect(adapter.supports("typescript")).toBe(true);
    expect(adapter.supports("javascript")).toBe(true);
    expect(adapter.supports("jsx")).toBe(true);
    expect(adapter.supports("python")).toBe(false);
  });

  it("extracts candidate symbols from TypeScript class and methods", () => {
    const code = `
      interface BatterRequest {
        id: string;
        batterName: string;
      }
      export class BattingLineupProcessor {
        private batterQueue: BatterRequest[] = [];
        public stepUpToPlate(batter: BatterRequest): void {
          this.batterQueue.push(batter);
        }
      }
    `;

    const symbols = adapter.extractCandidateSymbols(code);
    const names = symbols.map(s => s.name);
    expect(names).toContain("BatterRequest");
    expect(names).toContain("BattingLineupProcessor");
    expect(names).toContain("batterQueue");
    expect(names).toContain("stepUpToPlate");
  });

  it("does NOT extract or rewrite imported symbols", () => {
    const code = `
      import express from "express";
      import { Router } from "express";
      const app = express();
      const batterCount = 10;
    `;

    const symbols = adapter.extractCandidateSymbols(code);
    const names = symbols.map(s => s.name);
    expect(names).not.toContain("express");
    expect(names).not.toContain("Router");
    expect(names).toContain("batterCount");

    const rewritten = adapter.rewriteAst(code, {
      express: "fastServer",
      batterCount: "trainCount"
    });

    expect(rewritten.code).toContain('import express from "express"');
    expect(rewritten.code).toContain("const batterCount = 10;".replace("batterCount", "trainCount"));
    expect(rewritten.substitutedSymbols).toEqual(["batterCount"]);
  });

  it("rewrites AST identifiers and string literals while preserving comments", () => {
    const code = `
      // Important batting order comment
      class Lineup {
        /* block comment */
        private batter = "batter at plate";
        hit() {
          console.log("swings at ball");
        }
      }
    `;

    const res = adapter.rewriteAst(
      code,
      { batter: "passenger", hit: "boardTrain" },
      { "batter at plate": "passenger on platform", "swings at ball": "boards the train" }
    );

    expect(res.modified).toBe(true);
    expect(res.code).toContain("// Important batting order comment");
    expect(res.code).toContain("/* block comment */");
    expect(res.code).toContain("passenger = \"passenger on platform\"");
    expect(res.code).toContain("boardTrain()");
    expect(res.code).toContain('"boards the train"');
  });

  it("validates syntax correctly", () => {
    const validCode = `const x: number = 42;`;
    const invalidCode = `const x = ;;; def broken [`;

    expect(adapter.validateSyntax(validCode).valid).toBe(true);
    const invalidRes = adapter.validateSyntax(invalidCode);
    expect(invalidRes.valid).toBe(false);
    expect(invalidRes.error).toBeDefined();
  });

  it("shields import and export module specifiers against mockSubstitutions", () => {
    const code = `
      import { Queue } from "baseball-queue-lib";
      export * from "baseball-queue-lib";
      const batter = "three strikes";
    `;

    const res = adapter.rewriteAst(
      code,
      {},
      { "baseball-queue-lib": "train-queue-lib", "three strikes": "cancelled ticket" }
    );

    expect(res.code).toContain('import { Queue } from "baseball-queue-lib";');
    expect(res.code).toContain('export * from "baseball-queue-lib";');
    expect(res.code).toContain('const batter = "cancelled ticket";');
  });
});
