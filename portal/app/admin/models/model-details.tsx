'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Edit3, FlaskConical, MoreHorizontal, Power, Trash2, Users } from 'lucide-react';
import { Modal } from '../../components/modal';
import type { BackendModelConfiguration } from '../../lib/api-client';

const featureLabels: Record<string, string> = {
  supports_function_calling: '工具调用', supports_parallel_function_calling: '并行工具',
  supports_audio_input: '音频输入', supports_audio_output: '音频输出', supports_pdf_input: 'PDF 输入',
  supports_response_schema: '结构化输出', supports_prompt_caching: '提示词缓存',
  supports_reasoning: '推理', supports_web_search: '网页搜索', supports_tool_choice: '工具选择',
  supports_assistant_prefill: '助手预填充', supports_native_streaming: '原生流式输出',
  supports_system_messages: '系统消息',
};

function capabilities(model: BackendModelConfiguration) {
  const info = model.liteLlmCapabilities;
  const image = model.imageInput?.state === 'supported' ? '图片理解' : model.imageInput?.state === 'unsupported' ? '不支持图片' : '图片能力未确认';
  const features = info?.supportedFeatures ?? [];
  const tools = model.providerKind === 'LiteLLM' ? features.includes('supports_function_calling') : model.supportsTools;
  const core = [image, ...(tools ? ['工具调用'] : []), ...(features.includes('supports_reasoning') ? ['推理'] : []),
    ...(info?.mode ? [info.mode === 'chat' ? '对话' : info.mode] : model.providerKind !== 'LiteLLM' ? ['对话'] : [])];
  const advanced = features.filter(feature => !['supports_vision', 'supports_function_calling', 'supports_reasoning'].includes(feature))
    .map(feature => featureLabels[feature] ?? feature.replace(/^supports_/, '').replaceAll('_', ' '));
  return { image, core, advanced, all: [...new Set([...core, ...advanced])] };
}

export function ModelCapabilitySummary({ model, onDetails }: { model: BackendModelConfiguration; onDetails: () => void }) {
  const { all } = capabilities(model);
  return <div className="model-capability-summary"><div className="model-capability-tags">{all.slice(0, 3).map(label =>
    <span key={label} className={`model-capability-tag${label === '图片能力未确认' ? ' is-unknown' : ''}`} title={label === all[0] ? model.imageInput?.reason : undefined}>{label}</span>)}</div>
    {all.length > 3 && <button type="button" className="model-more-capabilities" aria-label={`查看${model.name}全部能力`} onClick={onDetails}>更多 {all.length - 3} 项</button>}
  </div>;
}

export function ModelRowActions({ model, onTest, onEdit, onGrants, onToggle, onRemove }: {
  model: BackendModelConfiguration; onTest: () => void; onEdit: () => void; onGrants: () => void; onToggle: () => void; onRemove: () => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector('button')?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) setOpen(false); };
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    const scroll = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', close);
    window.addEventListener('resize', scroll);
    window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', close); window.removeEventListener('resize', scroll); window.removeEventListener('scroll', scroll, true); };
  }, [open]);
  const act = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return <div className="table-actions model-row-actions">
    <button className="model-text-action" type="button" aria-label={`测试${model.name}`} title="测试连接：检查模型接口是否可用" onClick={onTest}><FlaskConical size={15} />测试</button>
    <button className="model-text-action" type="button" aria-label={`编辑${model.name}`} title="编辑模型配置" onClick={onEdit}><Edit3 size={15} />编辑</button>
    <button ref={trigger} className="icon-button" type="button" aria-label={`更多操作${model.name}`} title="更多操作" aria-expanded={open} aria-controls={open ? id : undefined} onClick={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      setPosition({ top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 154)), left: Math.max(8, rect.right - 168) });
      setOpen(!open);
    }}><MoreHorizontal size={18} /></button>
    {open && createPortal(<div ref={menu} id={id} className="model-action-menu" style={position}>
      <button type="button" aria-label={`授权${model.name}`} title="授权使用：设置可使用此模型的部门、角色和用户" onClick={() => act(onGrants)}><Users size={16} />授权使用</button>
      <button type="button" aria-label={`${model.isEnabled ? '停用' : '启用'}${model.name}`} onClick={() => act(onToggle)}><Power size={16} />{model.isEnabled ? '停用模型' : '启用模型'}</button>
      <button className="danger" type="button" aria-label={`删除${model.name}`} title="删除模型配置" onClick={() => act(onRemove)}><Trash2 size={16} />删除模型</button>
    </div>, document.body)}
  </div>;
}

export function ModelDetails({ model, onClose, onEdit }: { model: BackendModelConfiguration; onClose: () => void; onEdit: () => void }) {
  const body = useRef<HTMLDivElement>(null);
  const [copyMessage, setCopyMessage] = useState('');
  const { core, advanced } = capabilities(model);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = body.current?.closest<HTMLElement>('[role="dialog"]');
    dialog?.querySelector<HTMLButtonElement>('header button')?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>('button, [href], summary, [tabindex="0"]')).filter(node => !node.hasAttribute('disabled') && node.getClientRects().length > 0);
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog?.addEventListener('keydown', trap);
    return () => { dialog?.removeEventListener('keydown', trap); document.body.style.overflow = previousOverflow; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); };
  }, []);
  const copy = async () => {
    try { await navigator.clipboard.writeText(model.modelIdentifier); setCopyMessage('模型标识已复制'); }
    catch { setCopyMessage('复制失败，请选择模型标识手动复制'); }
  };
  return <Modal title="模型详情" className="model-details-drawer" onClose={onClose}>
    <div ref={body} className="model-details-body" tabIndex={0} aria-label="模型详情内容">
      <div className="model-details-heading"><h3>{model.name}</h3><span className={`status-pill ${model.isEnabled ? 'is-enabled' : 'is-disabled'}`}><i />{model.isEnabled ? '已启用' : '已停用'}</span>{model.isDefault && <span className="model-capability-tag">默认模型</span>}</div>
      <section><h3>基本信息</h3><dl className="model-detail-fields">
        <div className="model-detail-wide"><dt>模型标识</dt><dd><code>{model.modelIdentifier}</code><button type="button" className="icon-button" aria-label="复制模型标识" onClick={() => void copy()}><Copy size={15} /></button></dd></div>
        <div><dt>接入类型</dt><dd>{model.providerKind === 'Local' ? '本地模型' : model.providerKind === 'Online' ? '在线模型' : model.providerKind}</dd></div>
        <div><dt>倍率</dt><dd>{model.multiplier || '未设置'}</dd></div>
        <div className="model-detail-wide"><dt>Base URL</dt><dd>{model.baseUrl}</dd></div>
        <div className="model-detail-wide"><dt>接口路径</dt><dd>{model.endpointPath}</dd></div>
      </dl>{copyMessage && <p role="status">{copyMessage}</p>}</section>
      <section><h3>核心能力</h3><div className="model-capability-tags">{core.map(label => <span className="model-capability-tag" key={label}>{label}</span>)}</div><p className="model-image-reason">{model.imageInput?.reason || '图片能力尚未确认，请核对模型配置与上游披露信息。'}</p>{model.providerKind === 'LiteLLM' && !model.liteLlmCapabilities && <p>LiteLLM 未披露其他能力。</p>}</section>
      <section><h3>模型参数</h3><dl className="model-detail-fields">
        <div><dt>上下文长度</dt><dd>{model.liteLlmCapabilities?.contextWindow?.toLocaleString() ?? '未披露'}</dd></div>
        <div><dt>最大输出（上游）</dt><dd>{model.liteLlmCapabilities?.maxOutputTokens?.toLocaleString() ?? '未披露'}</dd></div>
        <div><dt>输出限制（配置）</dt><dd>{model.maxTokens?.toLocaleString() ?? '未限制'}</dd></div>
        <div><dt>Temperature</dt><dd>{model.temperature ?? '未设置'}</dd></div>
      </dl></section>
      <details className="model-advanced-capabilities"><summary>高级协议能力 · {advanced.length} 项</summary><div className="model-capability-tags">{advanced.map(label => <span className="model-capability-tag" key={label}>{label}</span>)}</div>{!advanced.length && <p>暂无额外披露信息</p>}</details>
    </div>
    <footer className="model-details-footer"><button type="button" className="secondary-action" onClick={onClose}>关闭</button><button type="button" className="primary-action" onClick={onEdit}><Edit3 size={16} />编辑模型</button></footer>
  </Modal>;
}
