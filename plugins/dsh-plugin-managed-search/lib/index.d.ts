import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';

/** Configuration resolved by the plugin schema before activation. */
export interface Config {
  requestTimeoutMs: number;
}

/** Loader identity of the managed web search provider. */
export declare const name: 'web-search-managed';
/** Services required before the provider can register. */
export declare const inject: ['web', 'credentials', 'managedBackend'];
/** Validates the request deadline and supplies its default. */
export declare const Config: Schema<Partial<Config>, Config>;

/** Register the provider for this Loader fiber's lifetime.
 * @param ctx Plugin context with its declared injected services.
 * @param config Schema-resolved search configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
