import { z } from "zod";

export const AlternativeMetaphorSchema = z.object({
  id: z.string(),
  metaphor: z.string(),
  rationale: z.string(),
  suggestedText: z.string(),
  isNeutralTechnical: z.boolean().default(false)
});

export type AlternativeMetaphor = z.infer<typeof AlternativeMetaphorSchema>;

export const IntentCardSchema = z.object({
  id: z.string(),
  sectionIndex: z.number(),
  codeBlockIndex: z.number().optional(),
  associatedSymbols: z.array(z.string()).default([]),
  originalMetaphor: z.string(),
  targetMetaphor: z.string(),
  mismatchReason: z.string(),
  rationale: z.string(),
  culturalContext: z.string(),
  confidence: z.number().min(0).max(1).default(0.9),
  alternatives: z.array(AlternativeMetaphorSchema).default([])
});

export type IntentCard = z.infer<typeof IntentCardSchema>;

export interface CandidateSymbol {
  name: string;
  kind: "variable" | "function" | "class" | "type" | "literal";
  line: number;
  contextSnippet: string;
}

export interface CodeBlockSlice {
  index: number;
  lang: string;
  startOffset: number;
  endOffset: number;
  originalCode: string;
  candidateSymbols: CandidateSymbol[];
  transformedCode?: string;
  associatedSectionIndices: number[];
  flaggedForHumanReview?: boolean;
  syntaxValid?: boolean;
}

export interface ProseNodeSlice {
  index: number;
  type: "paragraph" | "heading" | "blockquote" | "tableCell" | "list";
  startOffset: number;
  endOffset: number;
  originalText: string;
  maskedText: string;
  urlMap: Record<string, string>;
  inlineCodeTokens: string[];
  localizedText?: string;
  accepted?: boolean;
  selectedAlternativeId?: string;
  intentCard?: IntentCard;
}

export interface DocumentAnalysis {
  frontmatter?: string;
  frontmatterOffset?: { start: number; end: number };
  proseNodes: ProseNodeSlice[];
  codeBlocks: CodeBlockSlice[];
  detectedMetaphors: string[];
  symbolTable: Record<string, string>;
  mockSubstitutions: Record<string, string>;
}

export interface TranscreateConfig {
  defaultTargetLocale?: string;
  glossaryPath?: string;
  locales?: Record<string, {
    preferredDomains?: string[];
    avoidedMetaphors?: string[];
  }>;
}

export interface TranscreateOptions {
  filePath: string;
  targetLocale: string;
  model?: string;
  dryRun?: boolean;
  verify?: boolean;
  openBrowser?: boolean;
  serverPort?: number;
  glossaryPath?: string;
  glossaryRepo?: any;
  tenantContext?: { orgId: string; projectId?: string; userId?: string };
  llmProvider?: any;
}

export interface TranscreateResult {
  filePath: string;
  targetLocale: string;
  originalMarkdown: string;
  transcreatedMarkdown: string;
  intentCards: IntentCard[];
  symbolTable: Record<string, string>;
  codeBlocks: CodeBlockSlice[];
  proseNodes: ProseNodeSlice[];
  htmlViewerPath: string;
  stats: {
    metaphorsTranscreated: number;
    codeIdentifiersAdapted: number;
    codeBlocksValidated: number;
    proseNodesTranscreated: number;
  };
}

export interface CodeAdapter {
  supports(lang: string): boolean;
  extractCandidateSymbols(code: string): CandidateSymbol[];
  rewriteAst(
    code: string,
    symbolTable: Record<string, string>,
    mockSubstitutions?: Record<string, string>
  ): { code: string; modified: boolean; substitutedSymbols: string[] };
  validateSyntax(code: string): { valid: boolean; error?: string; line?: number };
}
