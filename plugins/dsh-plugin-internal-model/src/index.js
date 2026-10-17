import z from '@deepseek-ai/schemastery';
import { credentialKey } from '@deepseek-ai/dsh-credentials';
import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm';
import { PiAiAdapter, resolveProfiles, credentialStoreFrom, authContextFrom } from '@deepseek-ai/dsh-llm-pi-ai';

export const name = 'llm-internal-model';
export const inject = ['llm', 'credentials', 'managedBackend'];
export const Config = z.object({
  generationTimeoutSeconds: z.number().step(1).min(0).max(3600),
  streamIdleTimeoutSeconds: z.number().step(1).min(1).max(3600).default(300),
  requestTimeoutMs: z.number().min(1000).max(120000).default(15000),
  contextWindow: z.number().step(1).min(1024).max(2000000),
  maxOutputTokens: z.number().min(1).max(1000000).default(32768),
});
const provider = 'managed-internal';

async function* streamWithDeadline(ctx, prepared, route, options) {
  const started = performance.now();
  const timeout = route.timeoutSeconds === 0 ? undefined : AbortSignal.timeout(route.timeoutSeconds * 1000);
  const signal = timeout ? (options.signal ? AbortSignal.any([options.signal, timeout]) : timeout) : options.signal;
  let firstContentAt = null, lastContentAt = null;
  const events = { text: 0, reasoning: 0, toolCall: 0 };
  let usage = null, finishReason = null;
  const requestId = `${new Date().toISOString()}/${started.toFixed(6)}`;
  let reported = false;
  const report = (code, message = '') => {
    if (reported) return;
    reported = true;
    try {
      ctx.logger.warn('internal-model-request-diagnostic %s', JSON.stringify({
        requestId, provider, sessionId: options.sessionId, model: options.model,
        modelIdentifier: route.modelIdentifier, endpoint: route.baseURL,
        contextWindow: route.contextWindow, contextWindowSource: route.contextWindowSource,
        elapsedMs: Math.round(performance.now() - started), timeoutSeconds: route.timeoutSeconds,
        streamIdleTimeoutSeconds: route.streamIdleTimeoutSeconds,
        firstContentMs: firstContentAt === null ? null : Math.round(firstContentAt - started),
        lastContentAgoMs: lastContentAt === null ? null : Math.round(performance.now() - lastContentAt),
        contentEvents: events, usage, finishReason,
        failureCode: code, callerAborted: options.signal?.aborted ?? false,
        routeDeadlineAborted: timeout?.aborted ?? false,
        cancellationSource: options.signal?.aborted ? 'caller'
          : timeout?.aborted ? 'internal-route-total-deadline'
            : /stream idle timeout/i.test(message) ? 'stream-idle-timeout' : code === null ? null : 'upstream-or-sdk',
      }));
    } catch { /* Diagnostics cannot change the request outcome. */ }
  };
  try {
    for await (const chunk of prepared.stream({ ...options, provider, model: route.modelIdentifier,
      temperature: options.temperature ?? route.temperature,
      ...(options.maxTokens == null && route.maxTokens != null ? { maxTokens: route.maxTokens } : {}), signal })) {
      const contentKind = chunk.type === 'text-delta' && chunk.text ? 'text'
        : chunk.type === 'reasoning-delta' && chunk.text ? 'reasoning'
          : chunk.type === 'tool-call-delta' && (chunk.name || chunk.argumentsDelta) ? 'toolCall' : null;
      if (contentKind) {
        const now = performance.now();
        firstContentAt ??= now; lastContentAt = now; events[contentKind]++;
      }
      if (chunk.type === 'usage') usage = Object.fromEntries(Object.entries(chunk.usage).filter(([, value]) => typeof value === 'number'));
      if (chunk.type === 'finish') finishReason = chunk.reason.kind;
      if (chunk.type === 'finish' && ['error', 'aborted'].includes(chunk.reason.kind)) {
        report(chunk.reason.failure.code, chunk.reason.failure.message);
        if (timeout?.aborted && !options.signal?.aborted) {
          yield { ...chunk, reason: { kind: 'error', failure: { ...chunk.reason.failure,
            code: 'TIMEOUT', message: `内网模型请求超过 ${route.timeoutSeconds} 秒总时限；这是插件主动取消，不代表上下文超限` } } };
          return;
        }
      }
      yield chunk;
    }
  } catch (error) {
    report(error instanceof LlmError ? error.code : 'SDK_ERROR', error instanceof Error ? error.message : '');
    if (timeout?.aborted && !options.signal?.aborted)
      throw new LlmError(`内网模型请求超过 ${route.timeoutSeconds} 秒总时限`, 'TIMEOUT', { cause: error });
    throw error;
  } finally {
    if (!reported) report(finishReason === null ? 'CONSUMER_CLOSED' : null);
  }
}

function failure(status) {
  return new LlmError(`AIGC 内网模型授权请求失败 (HTTP ${status})`,
    status === 401 ? 'AUTH' : status === 403 ? 'MODEL_UNAUTHORIZED'
      : status === 404 ? 'MODEL_UNAVAILABLE' : status >= 500 ? 'SERVER' : 'INVALID_REQUEST', { status });
}
function catalog(value) {
  if (!value || !Array.isArray(value.models) || value.models.length > 10000)
    throw new LlmError('AIGC 内网模型目录无效', 'MALFORMED_RESPONSE');
  const ids = new Set();
  return value.models.map(model => {
    if (typeof model.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(model.id)
      || ids.has(model.id) || typeof model.name !== 'string' || !model.name)
      throw new LlmError('AIGC 内网模型目录无效', 'MALFORMED_RESPONSE');
    ids.add(model.id);
    return { provider, id: model.id, name: model.name, inputModalities: ['text'] };
  });
}
function connection(value) {
  if (!value || typeof value.modelIdentifier !== 'string' || !value.modelIdentifier
    || typeof value.apiKey !== 'string' || !['None', 'Bearer', 'Header'].includes(value.authType)
    || (value.authType !== 'None' && !value.apiKey) || typeof value.apiKeyHeader !== 'string'
    || typeof value.supportsTools !== 'boolean' || typeof value.temperature !== 'number'
    || value.temperature < 0 || value.temperature > 2
    || !Number.isInteger(value.timeoutSeconds) || value.timeoutSeconds < 1 || value.timeoutSeconds > 300
    || (value.maxTokens != null && (!Number.isInteger(value.maxTokens) || value.maxTokens < 1)))
    throw new LlmError('AIGC 内网模型连接参数无效', 'MALFORMED_RESPONSE');
  let url;
  try { url = new URL(value.baseURL); } catch { throw new LlmError('AIGC 内网模型地址无效', 'MALFORMED_RESPONSE'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new LlmError('AIGC 内网模型地址无效', 'MALFORMED_RESPONSE');
  return value;
}

export class InternalModelAdapter extends LlmAdapter {
  constructor(ctx, config) { super(); this.ctx = ctx; this.config = config; }
  providerInfo() { return { id: provider, name: 'AIGC 内网模型' }; }
  async request(path, signal) {
    const record = await this.ctx.credentials.readRecord(credentialKey('llm-managed-backend', 'user-session'));
    const token = this.ctx.managedBackend.accessToken
      ? await this.ctx.managedBackend.accessToken()
      : record?.kind === 'api-key' ? record.key : undefined;
    if (!token) throw new LlmError('请登录 AIGC 后使用内网模型', 'MISSING_CREDENTIAL');
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await fetch(`${this.ctx.managedBackend.endpoint}/v1/plugins/internal-model/models${path}`, {
        headers: { authorization: `Bearer ${token}` }, signal: abort, redirect: 'error', cache: 'no-store',
      });
      if (!response.ok) throw failure(response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new LlmError('AIGC 内网模型响应为空', 'MALFORMED_RESPONSE');
      let text = '', bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new LlmError('AIGC 内网模型响应过大', 'MALFORMED_RESPONSE');
          text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      return JSON.parse(text);
    } catch (error) {
      if (abort.aborted) throw new LlmError('内网模型授权请求已取消或超时', 'ABORTED');
      if (error instanceof LlmError) throw error;
      throw new LlmError('内网模型授权连接失败或响应无效', 'TRANSPORT');
    }
  }
  async listModels() {
    try { return catalog(await this.request('')); }
    catch (error) {
      if (error instanceof LlmError && ['MISSING_CREDENTIAL', 'MODEL_UNAUTHORIZED'].includes(error.code)) return [];
      throw error;
    }
  }
  async resolveConnection(id, signal) {
    const model = catalog(await this.request('', signal)).find(model => model.id === id);
    if (!model) throw new LlmError('当前用户未获此内网模型授权', 'MODEL_UNAUTHORIZED');
    const route = connection(await this.request(`/${encodeURIComponent(id)}/connection`, signal));
    const contextWindow = this.config.contextWindow ?? await this.discoverContextWindow(route, signal);
    return { route: { ...route, contextWindow,
      contextWindowSource: this.config.contextWindow === undefined ? 'models-api' : 'plugin-config' }, info: { ...model, context: { contextWindow },
      defaultMaxTokens: route.maxTokens ?? this.config.maxOutputTokens } };
  }
  async discoverContextWindow(route, signal) {
    const deadline = AbortSignal.timeout(this.config.requestTimeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const headers = new Headers();
    if (route.authType === 'Bearer') headers.set('authorization', `Bearer ${route.apiKey}`);
    if (route.authType === 'Header') headers.set(route.apiKeyHeader, route.apiKey);
    const url = `${route.baseURL.replace(/\/+$/, '')}/models`;
    try {
      const response = await fetch(url, { headers, signal: abort, redirect: 'error', cache: 'no-store' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty body');
      let text = '', bytes = 0;
      const decoder = new TextDecoder();
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          bytes += item.value.byteLength;
          if (bytes > 4 * 1024 * 1024) throw new Error('response too large');
          text += decoder.decode(item.value, { stream: true });
        }
        text += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const data = JSON.parse(text)?.data;
      if (!Array.isArray(data) || data.length > 10000) throw new Error('invalid model list');
      const matches = data.filter(item => item?.id === route.modelIdentifier);
      const value = matches.length === 1 ? matches[0].max_model_len : undefined;
      if (!Number.isSafeInteger(value) || value < 1024 || value > 2000000) throw new Error('missing or invalid capacity');
      return value;
    } catch {
      if (signal?.aborted) throw new LlmError('内网模型容量查询已取消', 'ABORTED');
      throw new LlmError('无法从内网模型 /models 自动获取当前模型的 max_model_len，请在插件配置中显式设置 contextWindow（与模型服务实际容量一致）', 'INVALID_MODEL_CONTEXT');
    }
  }
  async resolveModel(_provider, id, signal) {
    return (await this.resolveConnection(id, signal)).info;
  }
  async prepareCall(_provider, id, signal) {
    const { info, route } = await this.resolveConnection(id, signal);
    const headers = {};
    
    const profiles = resolveProfiles({ [provider]: {
      streamIdleTimeoutMs: (this.config.streamIdleTimeoutSeconds ?? 300) * 1000,
      displayName: 'AIGC 内网模型', api: 'openai-completions', baseURL: route.baseURL, headers,
      defaultContextWindow: info.context.contextWindow, defaultMaxTokens: this.config.maxOutputTokens,
      models: [{ id: route.modelIdentifier, name: info.name, input: ['text'] }],
    } });
    const direct = new PiAiAdapter({ profiles: () => profiles,
      onStreamFailure: value => {
        try { this.ctx.logger.warn('llm-request-diagnostic %s', JSON.stringify(value)); } catch { /* diagnostics only */ }
      },
      request: (url, init) => {
        const headers = new Headers(init?.headers);
        if (route.authType !== 'Bearer') headers.delete('authorization');
        if (route.authType === 'Header') headers.set(route.apiKeyHeader, route.apiKey);
        return fetch(url, { ...init, headers, redirect: 'error' });
      },
      resolveApiKey: async () => route.authType === 'Bearer' ? route.apiKey : 'local-no-auth',
      auth: { credentials: credentialStoreFrom(this.ctx), authContext: authContextFrom(this.ctx) },
    });
    const prepared = await direct.prepareCall(provider, route.modelIdentifier, signal);
    signal?.throwIfAborted();
    return { model: { ...prepared.model, ...info, ...(route.maxTokens == null ? {} : { defaultMaxTokens: route.maxTokens }) },
      stream: options => {
        if (!route.supportsTools && options.tools?.length)
          throw new LlmError('此内网模型未启用工具调用，请在 AIGC 模型管理中开启', 'UNSUPPORTED_OPTION');
        return streamWithDeadline(this.ctx, prepared, { ...route,
          timeoutSeconds: this.config.generationTimeoutSeconds ?? route.timeoutSeconds,
          streamIdleTimeoutSeconds: this.config.streamIdleTimeoutSeconds ?? 300 }, options);
      } };
  }
  async *stream(options) { const prepared = await this.prepareCall(provider, options.model, options.signal); yield* prepared.stream(options); }
}

export function apply(ctx, config) {
  if (!ctx.managedBackend.authorizeProvider) throw new TypeError('请更新 DSH：缺少组织模型 provider 扩展能力');
  ctx.effect(() => ctx.managedBackend.authorizeProvider(provider));
  ctx.llm.registerAdapter([provider], new InternalModelAdapter(ctx, config));
}
