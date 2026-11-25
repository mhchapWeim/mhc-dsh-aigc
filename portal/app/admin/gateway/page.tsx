"use client";

import { useEffect, useState } from "react";
import { getGatewaySettings, getPersonalGrants, revokePersonalGrant, saveGatewaySettings, type PersonalGrant } from "../../lib/api-client";
import "./gateway.css";

type ChangeRow = { id: string; actorName?: string; employeeNo?: string; createdAt: string; beforeJson: string; afterJson: string };

const readNumber = (json: string, camel: string, pascal: string) => {
  try {
    const value = JSON.parse(json) as Record<string, unknown>;
    const raw = value[camel] ?? value[pascal];
    return typeof raw === "number" ? raw : Number(raw);
  } catch { return Number.NaN; }
};

const describeChange = (beforeJson: string, afterJson: string) => {
  const pairs: Array<[string, string, string, string]> = [
    ["idleTimeoutMinutes", "IdleTimeoutMinutes", "空闲超时", "分钟"],
    ["maxSessionHours", "MaxSessionHours", "会话最长时长", "小时"],
    ["launchTicketSeconds", "LaunchTicketSeconds", "启动票据", "秒"],
  ];
  return pairs.map(([camel, pascal, label, unit]) => {
    const before = readNumber(beforeJson, camel, pascal);
    const after = readNumber(afterJson, camel, pascal);
    return `${label} ${Number.isFinite(before) ? before : "—"} → ${Number.isFinite(after) ? after : "—"} ${unit}`;
  }).join("；");
};

export default function GatewaySettingsPage() {
  const [idle, setIdle] = useState("30");
  const [hours, setHours] = useState("8");
  const [ticket, setTicket] = useState("60");
  const [changes, setChanges] = useState<ChangeRow[]>([]);
  const [grants, setGrants] = useState<PersonalGrant[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [settings, personal] = await Promise.all([getGatewaySettings(), getPersonalGrants()]);
      setIdle(String(settings.idleTimeoutMinutes));
      setHours(String(settings.maxSessionHours));
      setTicket(String(settings.launchTicketSeconds));
      setChanges(settings.changes ?? []);
      setGrants(personal.filter(item => !item.revokedAt));
    } catch (caught) {
      setChanges([]);
      setGrants([]);
      setError(caught instanceof Error ? caught.message : "网关配置加载失败");
    } finally { setLoading(false); }
  };
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, []);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setSaving(true);
    try {
      await saveGatewaySettings({ idleTimeoutMinutes: Number(idle), maxSessionHours: Number(hours), launchTicketSeconds: Number(ticket) });
      setNotice("已保存。新票据和新会话使用这次配置，已发出的票据和会话保持原时限。");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const revoke = async (grant: PersonalGrant) => {
    setError("");
    try {
      await revokePersonalGrant(grant.id, "管理员撤销");
      setNotice(`已撤销 ${grant.userName || "该用户"} 对 ${grant.appName || "目标应用"} 的个人访问权限`);
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "撤销失败"); }
  };
  return (
    <div className="admin-page page-enter admin-stack">
      <div className="page-title">
        <div>
          <span className="section-kicker">APPLICATION GATEWAY</span>
          <h1>应用网关配置</h1>
          <p>三项时长对全部发布应用生效，由启动接口和应用网关读取，不需要修改或重新加载 nginx。</p>
        </div>
      </div>
      {error && <p className="model-form-error" role="alert">{error}</p>}
      {notice && <p className="inline-toast" role="status">{notice}</p>}
      <form className="admin-panel gateway-settings" onSubmit={save}>
        <div className="form-grid">
          <label className="gateway-field">
            <span>空闲超时（分钟）</span>
            <input aria-label="空闲超时" required type="number" min={1} value={idle} onChange={event => setIdle(event.target.value)} />
            <small>页面、资源和接口计入活动。轮询、心跳和健康检查不延长空闲时间。默认 30。</small>
          </label>
          <label className="gateway-field">
            <span>会话最长时长（小时）</span>
            <input aria-label="会话最长时长" required type="number" min={1} value={hours} onChange={event => setHours(event.target.value)} />
            <small>从会话创建起计算，持续使用也不能超过。默认 8，且不能短于空闲超时。</small>
          </label>
          <label className="gateway-field">
            <span>启动票据有效期（秒）</span>
            <input aria-label="启动票据有效期" required type="number" min={1} value={ticket} onChange={event => setTicket(event.target.value)} />
            <small>一次性票据自签发起算，过期或兑换后不能再次使用。默认 60。</small>
          </label>
        </div>
        <div className="gateway-actions">
          <button className="primary-action" type="submit" disabled={saving || loading}>{saving ? "保存中" : "保存配置"}</button>
        </div>
      </form>
      <section className="admin-panel table-panel">
        <div className="table-meta"><span>最近变更 {changes.length}</span><span>新会话采用保存后的时限</span></div>
        {loading ? <p className="empty-state" role="status">正在加载配置</p> : changes.length === 0 ? <p className="empty-state">还没有配置变更</p> : (
          <div className="gateway-table">
            <table className="data-grid">
              <thead><tr><th>时间</th><th>修改人</th><th>变更</th></tr></thead>
              <tbody>
                {changes.map(change => (
                  <tr key={change.id}>
                    <td>{new Date(change.createdAt).toLocaleString("zh-CN")}</td>
                    <td>{change.actorName || "未知用户"}{change.employeeNo ? <small> {change.employeeNo}</small> : null}</td>
                    <td><p className="gateway-change">{describeChange(change.beforeJson, change.afterJson)}</p></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="admin-panel table-panel">
        <div className="table-meta"><span>生效中的个人授权 {grants.length}</span><span>撤销后按剩余授权重新判断</span></div>
        {loading ? <p className="empty-state" role="status">正在加载授权</p> : grants.length === 0 ? <p className="empty-state">没有生效中的个人授权</p> : (
          <div className="gateway-table">
            <table className="data-grid">
              <thead><tr><th>用户</th><th>应用</th><th>授权时间</th><th>操作</th></tr></thead>
              <tbody>
                {grants.map(grant => (
                  <tr key={grant.id}>
                    <td>{grant.userName || "未知用户"}{grant.employeeNo ? <><br /><small>{grant.employeeNo}</small></> : null}</td>
                    <td>{grant.appName || "未知应用"}</td>
                    <td>{new Date(grant.grantedAt).toLocaleString("zh-CN")}</td>
                    <td><button className="secondary-action" type="button" onClick={() => void revoke(grant)}>撤销</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
