import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type {} from '@deepseek-ai/dsh-llm-managed-backend';
export interface Config { generationTimeoutSeconds?: number; streamIdleTimeoutSeconds?: number; requestTimeoutMs: number; contextWindow?: number; maxOutputTokens: number; }
export declare const name: 'llm-internal-model';
export declare const inject: ['llm', 'credentials', 'managedBackend'];
export declare const Config: Schema<Partial<Config>, Config>;
export declare class InternalModelAdapter extends LlmAdapter {
  constructor(ctx: Context, config: Config);
  listModels(): Promise<LlmModelInfo[]>;
  private resolveConnection;
  private discoverContextWindow;
  resolveModel(provider: string, id: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  prepareCall(provider: string, id: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
  stream(options: GenerateOptions): AsyncGenerator<StreamChunk>;
}
export declare function apply(ctx: Context, config: Config): void;
