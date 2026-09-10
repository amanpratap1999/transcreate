import * as recast from "recast";
import * as babelParser from "@babel/parser";
import type { CandidateSymbol, CodeAdapter } from "../types.js";

const JS_TS_LANGS = new Set([
  "javascript", "js", "typescript", "ts", "jsx", "tsx", "mjs", "cjs"
]);

const RESERVED_GLOBALS = new Set([
  "constructor", "prototype", "__proto__", "valueOf", "toString", "hasOwnProperty",
  "isPrototypeOf", "propertyIsEnumerable", "toLocaleString",
  "console", "window", "global", "globalThis", "process", "document",
  "Math", "JSON", "Promise", "Date", "Array", "Object", "String",
  "Number", "Boolean", "Symbol", "BigInt", "RegExp", "Map", "Set",
  "WeakMap", "WeakSet", "Error", "TypeError", "RangeError", "SyntaxError",
  "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch",
  "require", "module", "exports", "import", "undefined", "null", "NaN",
  "Infinity", "this", "super", "arguments"
]);

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

const customParser = {
  parse(source: string) {
    return babelParser.parse(source, babelParserOptions);
  }
};

export class BabelAdapter implements CodeAdapter {
  supports(lang: string): boolean {
    const normalized = (lang || "").toLowerCase().trim();
    return JS_TS_LANGS.has(normalized);
  }

  extractCandidateSymbols(code: string): CandidateSymbol[] {
    const candidates: CandidateSymbol[] = [];
    const seen = new Set<string>();

    try {
      const ast = recast.parse(code, { parser: customParser });
      const importedNames = new Set<string>();

      // First pass: collect imported names
      recast.visit(ast, {
        visitNode(path) {
          const node: any = path.node;
          if (node.type === "ImportDeclaration" && node.specifiers) {
            for (const spec of node.specifiers) {
              if (spec.local?.name) {
                importedNames.add(spec.local.name);
              }
            }
          }
          if (
            node.type === "CallExpression" &&
            node.callee?.type === "Identifier" &&
            node.callee.name === "require" &&
            path.parentPath?.node?.type === "VariableDeclarator" &&
            path.parentPath.node.id?.type === "Identifier"
          ) {
            importedNames.add(path.parentPath.node.id.name);
          }
          this.traverse(path);
        }
      });

      // Second pass: collect candidate symbols
      recast.visit(ast, {
        visitNode(path) {
          const node: any = path.node;

          const addCandidate = (name: string, kind: CandidateSymbol["kind"], line: number, snippet: string) => {
            if (!importedNames.has(name) && !RESERVED_GLOBALS.has(name) && !seen.has(name)) {
              seen.add(name);
              candidates.push({ name, kind, line, contextSnippet: snippet });
            }
          };

          if (node.type === "VariableDeclarator" && node.id?.type === "Identifier") {
            addCandidate(node.id.name, "variable", node.loc?.start?.line ?? 1, node.id.name);
          } else if (node.type === "FunctionDeclaration" && node.id?.type === "Identifier") {
            addCandidate(node.id.name, "function", node.loc?.start?.line ?? 1, `${node.id.name}()`);
          } else if (node.type === "ClassDeclaration" && node.id?.type === "Identifier") {
            addCandidate(node.id.name, "class", node.loc?.start?.line ?? 1, `class ${node.id.name}`);
          } else if (
            (node.type === "ClassMethod" || node.type === "MethodDefinition") &&
            node.key?.type === "Identifier" &&
            node.key.name !== "constructor"
          ) {
            addCandidate(node.key.name, "function", node.loc?.start?.line ?? 1, `${node.key.name}()`);
          } else if (
            (node.type === "ClassProperty" || node.type === "PropertyDefinition") &&
            node.key?.type === "Identifier"
          ) {
            addCandidate(node.key.name, "variable", node.loc?.start?.line ?? 1, node.key.name);
          } else if (node.type === "TSInterfaceDeclaration" && node.id?.type === "Identifier") {
            addCandidate(node.id.name, "type", node.loc?.start?.line ?? 1, `interface ${node.id.name}`);
          } else if (node.type === "TSTypeAliasDeclaration" && node.id?.type === "Identifier") {
            addCandidate(node.id.name, "type", node.loc?.start?.line ?? 1, `type ${node.id.name}`);
          }

          this.traverse(path);
        }
      });
    } catch {
      // Non-fatal if snippet has partial/unparseable syntax
    }

    return candidates;
  }

  rewriteAst(
    code: string,
    symbolTable: Record<string, string>,
    mockSubstitutions: Record<string, string> = {}
  ): { code: string; modified: boolean; substitutedSymbols: string[] } {
    const substituted = new Set<string>();
    let isModified = false;

    if (Object.keys(symbolTable).length === 0 && Object.keys(mockSubstitutions).length === 0) {
      return { code, modified: false, substitutedSymbols: [] };
    }

    try {
      const ast = recast.parse(code, { parser: customParser });
      const importedNames = new Set<string>();

      // Collect imported names to protect them
      recast.visit(ast, {
        visitNode(path) {
          const node: any = path.node;
          if (node.type === "ImportDeclaration" && node.specifiers) {
            for (const spec of node.specifiers) {
              if (spec.local?.name) {
                importedNames.add(spec.local.name);
              }
            }
          }
          this.traverse(path);
        }
      });

      recast.visit(ast, {
        visitNode(path) {
          const node: any = path.node;

          // Rewrite identifiers
          if (node.type === "Identifier") {
            const name = node.name;
            if (
              !importedNames.has(name) &&
              !RESERVED_GLOBALS.has(name) &&
              Object.hasOwn(symbolTable, name)
            ) {
              node.name = symbolTable[name];
              substituted.add(name);
              isModified = true;
            }
          }

          // Guard against rewriting import/export module specifiers
          if (
            path.parentPath?.node?.type === "ImportDeclaration" ||
            path.parentPath?.node?.type === "ExportNamedDeclaration" ||
            path.parentPath?.node?.type === "ExportAllDeclaration"
          ) {
            this.traverse(path);
            return;
          }

          // Rewrite string literals in mock data
          if (node.type === "StringLiteral" && typeof node.value === "string") {
            for (const [orig, repl] of Object.entries(mockSubstitutions)) {
              if (node.value.includes(orig)) {
                node.value = node.value.replaceAll(orig, repl);
                substituted.add(orig);
                isModified = true;
              }
            }
          }

          // Rewrite template literals
          if (node.type === "TemplateElement" && node.value) {
            let raw = node.value.raw;
            let cooked = node.value.cooked ?? raw;
            let changed = false;

            for (const [orig, repl] of Object.entries(mockSubstitutions)) {
              if (raw.includes(orig)) {
                raw = raw.replaceAll(orig, repl);
                cooked = cooked.replaceAll(orig, repl);
                substituted.add(orig);
                changed = true;
                isModified = true;
              }
            }

            if (changed) {
              node.value.raw = raw;
              node.value.cooked = cooked;
            }
          }

          this.traverse(path);
        }
      });

      if (isModified) {
        const output = recast.print(ast).code;
        return {
          code: output,
          modified: true,
          substitutedSymbols: Array.from(substituted)
        };
      }
    } catch {
      // Safe fallback
    }

    return { code, modified: false, substitutedSymbols: [] };
  }

  validateSyntax(code: string): { valid: boolean; error?: string; line?: number } {
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
}

export class FallbackPassThroughAdapter implements CodeAdapter {
  supports(): boolean {
    return true;
  }

  extractCandidateSymbols(): CandidateSymbol[] {
    return [];
  }

  rewriteAst(code: string): { code: string; modified: boolean; substitutedSymbols: string[] } {
    return { code, modified: false, substitutedSymbols: [] };
  }

  validateSyntax(): { valid: boolean } {
    return { valid: true };
  }
}

const babelAdapter = new BabelAdapter();
const fallbackAdapter = new FallbackPassThroughAdapter();

export function getCodeAdapter(lang: string): CodeAdapter {
  if (babelAdapter.supports(lang)) {
    return babelAdapter;
  }
  return fallbackAdapter;
}
