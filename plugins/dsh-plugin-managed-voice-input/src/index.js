/** Local speech provider activated only by the managed bundle's Loader fiber. */
import { accessSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import * as sensevoice from '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice';

export const name = 'aigc-managed-voice-input';
export const inject = ['speechToText', 'subprocess'];
export const Config = z.object({ dataRoot: z.string().min(1).required() });

/** Register the bundled recognizer. Missing installer resources fail without downloading. */
export function apply(ctx, config) {
  const modelRoot = process.env.DSH_SPEECH_MODELS_ROOT;
  if (!modelRoot || !isAbsolute(modelRoot)) throw new Error('请更新客户端：缺少预置语音模型资源目录');
  for (const file of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) accessSync(join(modelRoot, file), constants.R_OK);
  ctx.plugin(sensevoice, { dataRoot: config.dataRoot, precision: 'int8',
    modelDirectory: modelRoot, vadModelPath: join(modelRoot, 'silero_vad.onnx') });
}
