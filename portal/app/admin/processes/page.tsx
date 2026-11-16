"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Plus,
  Search,
  RefreshCw,
  ArrowLeft,
  Copy,
  GitBranch,
} from "lucide-react";
import { AntPagination } from "../../components/ant-pagination";
import { Modal } from "../../components/modal";
import {
  getProcessDefinitions,
  saveProcessDefinition,
  disableProcessDefinition,
  type BackendProcessDefinition,
} from "../../lib/api-client";
import { readProcessDefinition } from "../../lib/process-layout";
import type { ProcessDefinition } from "../../lib/process-types";
import { integratedPublicationTemplate } from "../../lib/integrated-publication-template";

const status = (version: BackendProcessDefinition) =>
  version.isPublished ? "当前发布" : version.publishedAt ? "历史版本" : "草稿";
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString("zh-CN") : "—";

export default function ProcessManagementPage() {
  const router = useRouter();
  const [versions, setVersions] = useState<BackendProcessDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [useIntegrationTemplate, setUseIntegrationTemplate] = useState(false);
  const [confirmDisable, setConfirmDisable] =
    useState<BackendProcessDefinition | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setVersions(await getProcessDefinitions());
    } catch (e) {
      setError(e instanceof Error ? e.message : "流程加载失败");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const groups = useMemo(() => {
    const map = new Map<string, BackendProcessDefinition[]>();
    for (const version of versions)
      map.set(version.key, [...(map.get(version.key) ?? []), version]);
    return [...map].map(([key, items]) => ({
      key,
      items: items.sort((a, b) => b.version - a.version),
    }));
  }, [versions]);
  const filtered = groups.filter((group) =>
    `${group.key} ${group.items[0].name}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const selected = groups.find((group) => group.key === selectedKey);
  const createVersion = async (source?: BackendProcessDefinition) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const processKey = source?.key ?? key.trim();
      if (!source && versions.some((item) => item.key === processKey))
        throw new Error("流程编码已存在，请从该流程创建新版本");
      const definition: ProcessDefinition = source
        ? readProcessDefinition(source.definitionJson, source.name)
        : useIntegrationTemplate ? integratedPublicationTemplate(name.trim()) : { name: name.trim(), nodes: [], edges: [] };
      const created = await saveProcessDefinition({
        key: processKey,
        name: definition.name,
        version: 0,
        definition,
        isPublished: false,
      });
      router.push(`/admin/processes/${created.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    if (!confirmDisable || busy) return;
    setBusy(true);
    try {
      await disableProcessDefinition(confirmDisable.id);
      setConfirmDisable(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "停用失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-page page-enter process-management">
      <div className="page-title">
        <div>
          <h1>
            {selected ? `${selected.items[0].name} · 版本管理` : "流程管理"}
          </h1>
          <p>
            {selected
              ? "已发布版本只读；复制为新草稿后修改，运行中的实例继续使用原版本。"
              : "按流程管理定义与版本，进入草稿后设计节点、连线和处理人。"}
          </p>
        </div>
        <div className="process-list-actions">
          {selected && (
            <button
              className="secondary-action"
              type="button"
              onClick={() => {
                setSelectedKey(null);
                setPage(1);
              }}
            >
              <ArrowLeft size={16} />
              返回流程列表
            </button>
          )}
          <button
            className="primary-action"
            type="button"
            disabled={busy || loading}
            onClick={() => {
              if (selected) void createVersion(selected.items[0]);
              else {
                setName("");
                setKey("");
                setCreating(true);
              }
            }}
          >
            <Plus size={16} />
            {selected ? "新建版本" : "新建流程"}
          </button>
        </div>
      </div>
      {error && !creating && (
        <div className="model-form-error" role="alert">
          {error}
        </div>
      )}
      <div className="admin-panel toolbar">
        {!selected && (
          <label className="table-search">
            <Search size={17} />
            <input
              aria-label="搜索流程"
              placeholder="搜索流程名称或编码"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
            />
          </label>
        )}
        <button
          className="secondary-action"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </div>
      <section className="admin-panel table-panel">
        <div className="table-meta">
          <span>
            {selected
              ? `共 ${selected.items.length} 个版本`
              : `共 ${filtered.length} 个流程`}
          </span>
          <span>发布新版本不改变已有审批实例</span>
        </div>
        {loading ? (
          <div className="empty-state" role="status">
            正在加载流程…
          </div>
        ) : error && !versions.length ? (
          <div className="empty-state">加载失败，请刷新重试</div>
        ) : selected ? (
          <div className="table-wrap">
            <table className="data-grid">
              <thead>
                <tr>
                  <th>版本</th>
                  <th>状态</th>
                  <th>更新时间</th>
                  <th>首次发布时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {selected.items
                  .slice((page - 1) * pageSize, page * pageSize)
                  .map((item) => (
                    <tr key={item.id}>
                      <td>
                        <strong>V{item.version}</strong>
                      </td>
                      <td>
                        <span
                          className={`state-badge ${item.isPublished ? "is-enabled" : "is-disabled"}`}
                        >
                          {status(item)}
                        </span>
                      </td>
                      <td>{date(item.updatedAt)}</td>
                      <td>{date(item.publishedAt)}</td>
                      <td>
                        <div className="process-row-actions">
                          <Link href={`/admin/processes/${item.id}`}>
                            {item.isPublished || item.publishedAt
                              ? "查看设计"
                              : "编辑草稿"}
                          </Link>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void createVersion(item)}
                          >
                            <Copy size={14} />
                            复制为新版本
                          </button>
                          {item.isPublished && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setConfirmDisable(item)}
                            >
                              停用
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        ) : !filtered.length ? (
          <div className="empty-state">
            {query ? "没有匹配的流程" : "暂无流程，点击“新建流程”开始设计"}
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-grid">
              <thead>
                <tr>
                  <th>流程名称 / 编码</th>
                  <th>当前发布</th>
                  <th>最新草稿</th>
                  <th>版本数</th>
                  <th>更新时间</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filtered
                  .slice((page - 1) * pageSize, page * pageSize)
                  .map((group) => {
                    const latest = group.items[0];
                    const published = group.items.find(
                      (item) => item.isPublished,
                    );
                    const draft = group.items.find(
                      (item) => !item.isPublished && !item.publishedAt,
                    );
                    return (
                      <tr key={group.key}>
                        <td>
                          <strong>{latest.name}</strong>
                          <small className="process-key">{group.key}</small>
                        </td>
                        <td>
                          {published ? (
                            <span className="state-badge is-enabled">
                              V{published.version}
                            </span>
                          ) : (
                            "未发布"
                          )}
                        </td>
                        <td>{draft ? `V${draft.version}` : "—"}</td>
                        <td>{group.items.length}</td>
                        <td>
                          {date(
                            group.items.reduce((a, b) =>
                              a.updatedAt > b.updatedAt ? a : b,
                            ).updatedAt,
                          )}
                        </td>
                        <td>
                          <div className="process-row-actions">
                            {draft ? (
                              <Link href={`/admin/processes/${draft.id}`}>
                                编辑草稿
                              </Link>
                            ) : (
                              <button
                                disabled={busy}
                                type="button"
                                onClick={() => void createVersion(latest)}
                              >
                                <Plus size={14} />
                                新建版本
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setSelectedKey(group.key);
                                setPage(1);
                              }}
                            >
                              <GitBranch size={14} />
                              版本管理
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
        <AntPagination
          ariaLabel="流程分页"
          current={page}
          pageSize={pageSize}
          total={selected ? selected.items.length : filtered.length}
          onChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </section>
      {creating && (
        <Modal
          title="新建流程"
          onClose={() => {
            if (!busy) {
              setCreating(false);
              setError("");
            }
          }}
        >
          <form
            className="entity-form"
            onSubmit={(e) => {
              e.preventDefault();
              void createVersion();
            }}
          >
            <label>
              <span>流程名称</span>
              <input
                autoFocus
                required
                maxLength={150}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如：设备维修审批"
              />
            </label>
            <label>
              <span>流程编码</span>
              <input
                aria-label="流程编码"
                required
                pattern="[a-z][a-z0-9-]{1,79}"
                maxLength={80}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="例如：equipment-repair"
              />
              <small>2–80 位小写字母、数字或连字符，创建后不可修改。</small>
            </label>
            <label><span><input type="checkbox" checked={useIntegrationTemplate} onChange={event => setUseIntegrationTemplate(event.target.checked)} /> 使用代码审计与部署模板</span><small>生成 MQ 审计 → 部署审批 → MQ 部署流程；发布前需配置并启用对应服务。</small></label>
            {error && (
              <div className="model-form-error" role="alert">
                {error}
              </div>
            )}
            <footer className="modal-actions">
              <button
                className="secondary-action"
                type="button"
                disabled={busy}
                onClick={() => {
                  setCreating(false);
                  setError("");
                }}
              >
                取消
              </button>
              <button className="primary-action" type="submit" disabled={busy}>
                {busy ? "正在创建…" : "创建并设计"}
              </button>
            </footer>
          </form>
        </Modal>
      )}
      {confirmDisable && (
        <Modal
          title="停用当前发布版本"
          onClose={() => {
            if (!busy) setConfirmDisable(null);
          }}
        >
          <div className="entity-form">
            <p>
              停用“{confirmDisable.name}” V{confirmDisable.version}{" "}
              后，新申请将无法使用该流程。已有实例继续按原版本处理。
            </p>
            <footer className="modal-actions">
              <button
                className="secondary-action"
                type="button"
                disabled={busy}
                onClick={() => setConfirmDisable(null)}
              >
                取消
              </button>
              <button
                className="primary-action"
                type="button"
                disabled={busy}
                onClick={() => void disable()}
              >
                {busy ? "正在停用…" : "确认停用"}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}
