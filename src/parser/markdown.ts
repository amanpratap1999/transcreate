import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import MagicString from "magic-string";
import type { Node, Position } from "unist";
import type { CodeBlockSlice, DocumentAnalysis, ProseNodeSlice } from "../types.js";
import { getCodeAdapter } from "./code.js";

// Custom node type guards
interface MdastNode extends Node {
  type: string;
  value?: string;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  children?: MdastNode[];
  position?: Position;
}

export class MarkdownParser {
  private processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ["yaml"])
    .use(remarkGfm)
    .use(remarkMdx);

  /**
   * Parses Markdown / MDX source and extracts prose nodes and code fences with exact character offsets.
   */
  public analyzeDocument(source: string): DocumentAnalysis {
    const tree = this.processor.parse(source) as MdastNode;
    const proseNodes: ProseNodeSlice[] = [];
    const codeBlocks: CodeBlockSlice[] = [];
    let frontmatter: string | undefined;
    let frontmatterOffset: { start: number; end: number } | undefined;

    let proseIndex = 0;
    let codeIndex = 0;

    const walk = (node: MdastNode) => {
      // 1. YAML Frontmatter
      if (node.type === "yaml") {
        if (node.position) {
          const start = node.position.start.offset ?? 0;
          const end = node.position.end.offset ?? 0;
          frontmatter = source.slice(start, end);
          frontmatterOffset = { start, end };
        }
        return;
      }

      // 2. MDX Custom Elements & Expressions (Freeze as immutable)
      if (
        node.type === "mdxJsxFlowElement" ||
        node.type === "mdxJsxTextElement" ||
        node.type === "mdxjsEsm" ||
        node.type === "mdxFlowExpression" ||
        node.type === "mdxTextExpression"
      ) {
        // Child text nodes inside custom MDX components can still be traversed if desired,
        // but the tags themselves remain intact.
        if (node.children) {
          for (const child of node.children) {
            walk(child);
          }
        }
        return;
      }

      // 3. Code Block Fences
      if (node.type === "code") {
        if (node.position && node.value !== undefined) {
          const start = node.position.start.offset ?? 0;
          const end = node.position.end.offset ?? 0;
          const lang = node.lang || "text";
          const rawCode = node.value;
          const adapter = getCodeAdapter(lang);
          const candidateSymbols = adapter.extractCandidateSymbols(rawCode);

          codeBlocks.push({
            index: codeIndex++,
            lang,
            startOffset: start,
            endOffset: end,
            originalCode: rawCode,
            candidateSymbols,
            associatedSectionIndices: []
          });
        }
        return;
      }

      // 4. Translatable Prose Nodes
      if (
        node.type === "paragraph" ||
        node.type === "heading" ||
        node.type === "blockquote" ||
        node.type === "tableCell"
      ) {
        if (node.position) {
          const start = node.position.start.offset ?? 0;
          const end = node.position.end.offset ?? 0;
          const originalText = source.slice(start, end);

          // Mask links/images and detect inline code tokens
          const { maskedText, urlMap, inlineCodeTokens } = this.maskAndExtractInline(node, source);

          // Only add non-empty prose
          if (originalText.trim().length > 0) {
            proseNodes.push({
              index: proseIndex++,
              type: node.type as ProseNodeSlice["type"],
              startOffset: start,
              endOffset: end,
              originalText,
              maskedText,
              urlMap,
              inlineCodeTokens
            });
          }
        }
        return;
      }

      // Traverse children for other container types (root, list, listItem, table, etc.)
      if (node.children) {
        for (const child of node.children) {
          walk(child);
        }
      }
    };

    walk(tree);

    return {
      frontmatter,
      frontmatterOffset,
      proseNodes,
      codeBlocks,
      detectedMetaphors: [],
      symbolTable: {},
      mockSubstitutions: {}
    };
  }

  /**
   * Mask URLs in markdown links/images and collect inline code backticks.
   */
  private maskAndExtractInline(
    node: MdastNode,
    source: string
  ): { maskedText: string; urlMap: Record<string, string>; inlineCodeTokens: string[] } {
    const urlMap: Record<string, string> = {};
    const inlineCodeTokens: string[] = [];
    let urlCounter = 0;

    const nodeStart = node.position?.start.offset ?? 0;
    const nodeEnd = node.position?.end.offset ?? 0;
    const rawContent = source.slice(nodeStart, nodeEnd);

    // Track replacements within this node's local offset
    const localReplacements: Array<{ start: number; end: number; token: string }> = [];

    const visitChildren = (curr: MdastNode) => {
      if (curr.type === "link" || curr.type === "image") {
        if (curr.url && curr.position) {
          const existingToken = Object.entries(urlMap).find(([, u]) => u === curr.url)?.[0];
          if (!existingToken) {
            const token = `__URL_REF_${urlCounter++}__`;
            urlMap[token] = curr.url;
          }
        }
      }

      if (curr.type === "inlineCode" && curr.value) {
        inlineCodeTokens.push(curr.value.trim());
      }

      if (curr.children) {
        for (const c of curr.children) {
          visitChildren(c);
        }
      }
    };

    visitChildren(node);

    // Replace URLs in raw text with tokens
    let masked = rawContent;
    for (const [token, url] of Object.entries(urlMap)) {
      masked = masked.replaceAll(url, token);
    }

    return { maskedText: masked, urlMap, inlineCodeTokens };
  }

  /**
   * Unmasks URLs in localized text.
   */
  public unmaskUrls(text: string, urlMap: Record<string, string>): string {
    let result = text;
    for (const [token, url] of Object.entries(urlMap)) {
      result = result.replaceAll(token, url);
    }
    return result;
  }

  /**
   * Synchronizes inline code backticks in localized prose using the document symbolTable.
   */
  public syncInlineCode(text: string, symbolTable: Record<string, string>): string {
    if (Object.keys(symbolTable).length === 0) {
      return text;
    }

    return text.replace(/`([^`]+)`/g, (match, inner) => {
      const trimmed = inner.trim();
      if (Object.hasOwn(symbolTable, trimmed)) {
        return `\`${symbolTable[trimmed]}\``;
      }
      if (trimmed.endsWith("()")) {
        const fnName = trimmed.slice(0, -2).trim();
        if (Object.hasOwn(symbolTable, fnName)) {
          return `\`${symbolTable[fnName]}()\``;
        }
      }
      return match;
    });
  }

  /**
   * Applies surgical bottom-up patching to source markdown using reverse-sorted offsets.
   * Eliminates multibyte character drift.
   */
  public spliceDocument(
    source: string,
    replacements: Array<{ start: number; end: number; text: string }>
  ): string {
    const s = new MagicString(source);

    // Crucial: Sort descending by start offset
    const sorted = [...replacements].sort((a, b) => b.start - a.start);

    for (const rep of sorted) {
      s.overwrite(rep.start, rep.end, rep.text);
    }

    return s.toString();
  }
}
