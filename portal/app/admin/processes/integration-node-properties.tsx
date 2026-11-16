'use client';
import { useEffect, useState } from 'react';
import { ModernSelect } from '../../components/modern-select';
import { getIntegrations, type IntegrationService, type IntegrationOperation } from '../../lib/integrations';
import type { ProcessNode } from '../../lib/process-types';

export function IntegrationNodeProperties({ node, update }: { node: ProcessNode; update: (patch: Partial<ProcessNode>) => void }) {
  const [services, setServices] = useState<IntegrationService[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; getIntegrations().then(rows => { if (active) setServices(rows.filter(r => r.kind === 'Mq' && r.isEnabled)); }).catch(e => { if (active) setError(e.message); }); return () => { active = false; }; }, []);
  const operations: IntegrationOperation[] = JSON.parse(services.find(s => s.code === node.serviceCode)?.operationsJson ?? '[]');
  const codeReview = operations.find(o => o.code === node.operationCode)?.protocol === 'code-review-20261112' || node.operationCode === 'review.requested';
  return <>
    <div className="property-field"><span>第三方服务</span><ModernSelect ariaLabel="第三方服务" value={node.serviceCode ?? ''} options={services.map(s => ({ value: s.code, label: s.name }))} onChange={serviceCode => update({ serviceCode, operationCode: '', timeoutSeconds: node.timeoutSeconds ?? 86400 })} /></div>
    <div className="property-field"><span>服务操作</span><ModernSelect ariaLabel="服务操作" value={node.operationCode ?? ''} options={operations.map(o => ({ value: o.code, label: o.code, description: `结果：${o.resultEvent}` }))} onChange={operationCode => update({ operationCode })} /></div>
    <label><span>等待超时（秒）</span><input type="number" min={60} max={604800} value={node.timeoutSeconds ?? 86400} onChange={e => update({ timeoutSeconds: Number(e.target.value) })} /></label>
    <label><span><input type="checkbox" checked={node.verifyCommit ?? false} onChange={e => update({ verifyCommit: e.target.checked })} /> 校验结果 Commit 与申请一致</span></label>
    <label><span>部署地址结果字段（部署节点填写）</span><input value={node.deploymentUrlField ?? ''} placeholder="deploymentUrl" onChange={e => update({ deploymentUrlField: e.target.value })} /></label>
    <p>默认发送应用、仓库、分支、Commit、版本和环境。配置连线的结果条件决定后续流转。</p>
    {codeReview && <p>代码审查协议：自动发送申请人工号、Gitea 仓库全名和冻结 Commit；须将 needs-review 出口连接人工复核节点。支持 review.finished 与 review.rejected 两种结果。</p>}
    {!codeReview && ['repositoryUrl', 'branch', 'commitSha', 'version', 'environment', 'appName'].map(field => <label key={field}><span>请求字段 {field} 的数据来源</span><select aria-label={`${field} 数据来源`} value={node.inputMappings?.[field] ?? (node.inputMappings ? '' : `request.${field}`)} onChange={e => {
      const mappings = { ...(node.inputMappings ?? Object.fromEntries(['repositoryUrl', 'branch', 'commitSha', 'version', 'environment', 'appName'].map(f => [f, `request.${f}`]))) };
      if (e.target.value) mappings[field] = e.target.value; else delete mappings[field];
      update({ inputMappings: mappings });
    }}><option value="">不发送</option>{['repositoryUrl', 'branch', 'commitSha', 'version', 'environment', 'appName'].map(f => <option key={f} value={`request.${f}`}>{`申请.${f}`}</option>)}</select></label>)}
    {error && <p role="alert">{error}</p>}
  </>;
}
