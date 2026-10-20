'use client';

import { useState } from 'react';
import type { VirtualKeyPolicy, VirtualKeyPolicyView } from '../../lib/api-client';

export type PolicyDraft = {
  allModels: boolean; models: string[]; maxBudget: string; budgetDuration: string;
  rpmLimit: string; tpmLimit: string; expiryMode: 'keep' | 'duration' | 'never'; duration: string;
};
export const policyDraft = (current?: VirtualKeyPolicyView): PolicyDraft => ({
  allModels: current?.allModels ?? false, models: current?.models ?? [], maxBudget: String(current?.maxBudget ?? ''),
  budgetDuration: current?.budgetDuration ?? '', rpmLimit: String(current?.rpmLimit ?? ''),
  tpmLimit: String(current?.tpmLimit ?? ''), expiryMode: current ? 'keep' : 'never', duration: '',
});
export function policyInput(value: PolicyDraft): VirtualKeyPolicy {
  const numeric = (text: string) => text.trim() === '' ? null : Number(text);
  return { models: value.allModels ? [] : value.models, allModels: value.allModels,
    maxBudget: numeric(value.maxBudget), budgetDuration: value.budgetDuration.trim() || null,
    rpmLimit: numeric(value.rpmLimit), tpmLimit: numeric(value.tpmLimit),
    duration: value.expiryMode === 'duration' ? value.duration.trim() : null,
    clearExpiry: value.expiryMode === 'never' };
}

export function KeyPolicyFields({ value, onChange, models, current }: {
  value: PolicyDraft; onChange: (value: PolicyDraft) => void; models: string[]; current?: VirtualKeyPolicyView;
}) {
  const [query, setQuery] = useState('');
  const available = [...new Set([...models, ...value.models])].filter(model => model.toLowerCase().includes(query.toLowerCase()));
  return <>
    <fieldset className="virtual-key-models"><legend>LiteLLM 模型范围</legend>
      <label className="virtual-key-inline"><input type="radio" name="model-scope" checked={!value.allModels} onChange={() => onChange({ ...value, allModels: false })} />指定模型</label>
      <label className="virtual-key-inline"><input type="radio" name="model-scope" checked={value.allModels} onChange={() => onChange({ ...value, allModels: true })} />全部可用模型（含以后新增）</label>
      {!value.allModels && <><label>搜索模型<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="按 LiteLLM 模型标识搜索" /></label>
        <div className="virtual-key-model-list" aria-label="可用模型">{available.map(model => <label key={model} className="virtual-key-inline">
          <input type="checkbox" checked={value.models.includes(model)} onChange={event => onChange({ ...value,
            models: event.target.checked ? [...value.models, model] : value.models.filter(item => item !== model) })} />
          <span>{model}{!models.includes(model) && <small>（当前目录未列出，保留已有授权）</small>}</span>
        </label>)}{available.length === 0 && <p>没有匹配的模型，请检查 LiteLLM 模型目录。</p>}</div>
        <p className="recipient-hint">已选 {value.models.length} 个模型。仍需配置 AIGC 模型授权，并受网关和团队权限限制。</p></>}
    </fieldset>
    <div className="form-grid">
      <label>预算上限（美元）<input type="number" min="0" step="0.000001" value={value.maxBudget} onChange={event => onChange({ ...value, maxBudget: event.target.value })} placeholder="留空：不设置 Key 级预算" /></label>
      <label>预算重置周期<input value={value.budgetDuration} pattern="([1-9][0-9]{0,6}(mo|[smhdw])|hourly|daily|weekly|monthly)" onChange={event => onChange({ ...value, budgetDuration: event.target.value })} placeholder="例如 30d、monthly；留空不定期重置" /></label>
      <label>每分钟请求数（RPM）<input type="number" min="1" step="1" value={value.rpmLimit} onChange={event => onChange({ ...value, rpmLimit: event.target.value })} placeholder="留空：不设置 Key 级限制" /></label>
      <label>每分钟 Token 数（TPM）<input type="number" min="1" step="1" value={value.tpmLimit} onChange={event => onChange({ ...value, tpmLimit: event.target.value })} placeholder="留空：不设置 Key 级限制" /></label>
      <label>有效期<select value={value.expiryMode} onChange={event => onChange({ ...value, expiryMode: event.target.value as PolicyDraft['expiryMode'] })}>
        {current && <option value="keep">保持当前到期时间</option>}<option value="duration">从本次保存起设置时长</option><option value="never">永久有效</option>
      </select></label>
      {value.expiryMode === 'duration' && <label>有效时长<input required pattern="([1-9][0-9]{0,6}(mo|[smhdw])|hourly|daily|weekly|monthly)" value={value.duration} onChange={event => onChange({ ...value, duration: event.target.value })} placeholder="例如 30d、720h" /></label>}
    </div>
    {current && <p className="recipient-hint">当前到期时间：{current.expires ? new Date(current.expires).toLocaleString() : '永久有效'}。保持当前到期时间不会续期。</p>}
    <p className="recipient-hint">预算为 0 表示零预算。周期支持 s 秒、m 分钟、h 小时、d 天、w 周、mo 月，以及 hourly/daily/weekly/monthly。修改重置周期会重新安排预算窗口；网关或团队已有的更严格限制仍然生效。</p>
  </>;
}
