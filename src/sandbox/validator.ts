import * as babelParser from "@babel/parser";
import type { CodeBlockSlice, ProseNodeSlice } from "../types.js";

const babelParserOptions: babelParser.ParserOptions = {
  sourceType: "module",
  allowImportExportEverywhere: true,
  allowReturnOutsideFunction: true,
  plugins: [
    "typescript",
    "jsx",
    "decorators-legacy",
    "classProperties",
    "exportDefaultFrom"
  ]
};

export interface RepairContext {
  code: string;
  error: string;
  line?: number;
  originalCode: string;
}

export type CodeRepairFunction = (ctx: RepairContext) => Promise<string>;

export class CodeValidator {
  /**
   * Validate JS/TS code syntax via Babel parser.
   */
  public validate(code: string): { valid: boolean; error?: string; line?: number } {
    try {
      babelParser.parse(code, babelParserOptions);
      return { valid: true };
    } catch (err: unknown) {
      const error = err as { message?: string; loc?: { line: number } };
      return {
        valid: false,
        error: error.message ?? "Unknown syntax error",
        line: error.loc?.line
      };
    }
  }

  /**
   * Validates a code block slice. If invalid, executes a 1-shot repair attempt.
   * If repair fails, triggers correlated rollback on both the code block and its referencing prose nodes.
   */
  public async validateAndHeal(
    codeBlock: CodeBlockSlice,
    proseNodes: ProseNodeSlice[],
    repairFn?: CodeRepairFunction
  ): Promise<{
    healed: boolean;
    rolledBack: boolean;
    error?: string;
  }> {
    const candidateCode = codeBlock.transformedCode ?? codeBlock.originalCode;
    const initialCheck = this.validate(candidateCode);

    if (initialCheck.valid) {
      codeBlock.syntaxValid = true;
      codeBlock.flaggedForHumanReview = false;
      return { healed: false, rolledBack: false };
    }

    // 1-Shot Repair Attempt
    if (repairFn) {
      try {
        const repairedCode = await repairFn({
          code: candidateCode,
          error: initialCheck.error ?? "Syntax error",
          line: initialCheck.line,
          originalCode: codeBlock.originalCode
        });

        const repairedCheck = this.validate(repairedCode);
        if (repairedCheck.valid) {
          codeBlock.transformedCode = repairedCode;
          codeBlock.syntaxValid = true;
          codeBlock.flaggedForHumanReview = false;
          return { healed: true, rolledBack: false };
        }
      } catch {
        // Repair invocation failed
      }
    }

    // Correlated Rollback
    // Rollback code block to original
    codeBlock.transformedCode = codeBlock.originalCode;
    codeBlock.syntaxValid = false;
    codeBlock.flaggedForHumanReview = true;

    // Rollback referencing prose nodes to original text
    for (const secIndex of codeBlock.associatedSectionIndices) {
      const matchedProse = proseNodes.find(p => p.index === secIndex);
      if (matchedProse) {
        matchedProse.localizedText = matchedProse.originalText;
        matchedProse.accepted = false;
      }
    }

    return {
      healed: false,
      rolledBack: true,
      error: initialCheck.error
    };
  }
}
