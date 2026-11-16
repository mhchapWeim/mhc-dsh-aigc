import type { Context } from '@deepseek-ai/cordis';
import type Schema from '@deepseek-ai/schemastery';
export interface Config { dataRoot: string; }
export declare const name: 'aigc-managed-voice-input';
export declare const inject: ['speechToText', 'subprocess'];
export declare const Config: Schema<Config, Config>;
/** Register the installer-provided recognizer for the owning Loader fiber's lifetime. */
export declare function apply(ctx: Context, config: Config): void;
