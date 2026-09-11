import type { TranscreateOptions, TranscreateResult } from "../types.js";

export interface IGlossaryRepository {
  getGlossary(orgId: string, projectId: string | undefined, locale: string): Promise<Record<string, any>>;
  saveGlossary(orgId: string, projectId: string | undefined, locale: string, mappings: Record<string, any>): Promise<void>;
}

export interface LLMStructuredRequest<T> {
  systemPrompt: string;
  userPrompt: string;
  schema: any;
  model?: string;
  tenantContext?: {
    orgId: string;
    userId: string;
  };
}

export interface LLMStructuredResponse<T> {
  data: T;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalCostCents: number;
  };
}

export interface ILLMProvider {
  generateStructured<T>(request: LLMStructuredRequest<T>): Promise<LLMStructuredResponse<T>>;
}

export interface ITranscreateEngine {
  transcreate(sourceMarkdown: string, options: TranscreateOptions): Promise<TranscreateResult>;
}