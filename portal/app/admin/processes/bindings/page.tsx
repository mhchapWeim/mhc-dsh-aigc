"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getProcessBindings, saveProcessBinding, type ProcessBinding } from "../../../lib/api-client";
import "./bindings.css";

export default function ProcessBindingPage() {
  const [rows, setRows] = useState<ProcessBinding[]>([]);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const items = await getProcessBindings();
      const list = Array.isArray(items) ? items : [];
      setRows(list);
      setSelected(Object.fromEntries(list.map(item => [item.requestType, item.processKey ?? ""])));
    } catch (caught) { setRows([]); setError(caught instanceof Error ? caught.message : "流程绑定加载失败"); }
    finally { setLoading(false); }
  };
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);
  const save = async (row: ProcessBinding) => {
    setError("");
    setNotice("");
    setSaving(row.requestType);
    try {
      await saveProcessBinding(row.requestType, selected[row.requestType] ?? "");
      setNotice(`${row.label}已绑定所选流程，只影响之后提交的申请`);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setSaving(""); }
  };
  return (
    <div className="admin-page page-enter admin-stack">
      <div className="page-title">
        <div>
          <span className="section-kicker">PROCESS BINDING</span>
          <h1>流程绑定</h1>
          <p>每种申请只保留一条生效绑定。下拉列出适用于该类型且已发布的流程，保存其流程编码。</p>
        </div>
        <Link className="secondary-action" href="/admin/processes">返回流程管理</Link>
      </div>
      {error && <p className="model-form-error" role="alert">{error}</p>}
      {notice && <p className="inline-toast" role="status">{notice}</p>}
      <section className="admin-panel table-panel">
        <div className="table-meta"><span>共 {rows.length} 类申请</span><span>保存后立即用于新申请</span></div>
        {loading ? <p className="empty-state" role="status">正在加载流程绑定</p> : rows.length === 0 ? <p className="empty-state">没有可配置的申请类型</p> : (
          <div className="table-scroll binding-table">
            <table className="data-grid">
              <thead><tr><th>申请类型</th><th>已绑定流程</th><th>生效版本</th><th>状态</th><th>更换绑定</th></tr></thead>
              <tbody>
                {rows.map(row => {
                  const options = row.options ?? [];
                  return (
                    <tr key={row.requestType}>
                      <td>{row.label}</td>
                      <td>{row.processName ? `${row.processName}（${row.processKey}）` : "尚未绑定"}</td>
                      <td>{row.publishedVersion ? `V${row.publishedVersion}` : "—"}</td>
                      <td>{row.status}</td>
                      <td>
                        <div className="binding-actions">
                          <label>
                            <span className="sr-only">{row.label}流程</span>
                            <select aria-label={`${row.label}流程`} value={selected[row.requestType] ?? ""} onChange={event => setSelected(current => ({ ...current, [row.requestType]: event.target.value }))}>
                              <option value="">{options.length ? "请选择流程" : "没有已发布流程"}</option>
                              {options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
                            </select>
                          </label>
                          <button className="primary-action" type="button" disabled={!selected[row.requestType] || saving === row.requestType} onClick={() => void save(row)}>{saving === row.requestType ? "保存中" : "保存"}</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="binding-note">访问申请可以新建编码为 application-access 的流程，发布后再在这里绑定。未绑定或没有已发布版本时，提交会被拒绝，也不会留下申请。</p>
    </div>
  );
}
