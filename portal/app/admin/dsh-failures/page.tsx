"use client";

import { useEffect, useRef, useState } from "react";
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from "../../components/ant-pagination";
import {
  downloadDshFailure,
  getDshFailure,
  getDshFailures,
  type DshFailureDetail,
  type DshFailureRow,
} from "../../lib/api-client";
import "./style.css";

const initial = {
  user: "",
  device: "",
  version: "",
  category: "",
  from: "",
  to: "",
};
const categories = [
  "installer",
  "llm",
  "tool",
  "agent",
  "host-log",
  "host-stderr",
  "http",
  "renderer",
  "main",
  "fatal",
];
const categoryLabels: Record<string, string> = {
  installer: "安装失败",
  llm: "模型请求",
  tool: "工具执行",
  agent: "智能体运行",
  "host-log": "运行服务日志",
  "host-stderr": "运行服务错误输出",
  http: "HTTP 请求",
  renderer: "客户端界面",
  main: "桌面主进程",
  fatal: "致命故障",
};
function operationLabel(category: string, operation: string) {
  if (category === "installer") return ({ preflight: "安装前检查", staging: "创建安装暂存目录", extract: "解压安装文件", promote: "替换旧版文件", install: "安装注册", launch: "启动应用" } as Record<string, string>)[operation] ?? operation;
  if (category === "llm")
    return operation === "managed"
      ? "AIGC 托管模型调用"
      : `模型调用 · ${operation}`;
  if (category === "agent" && operation === "agent/error")
    return "智能体运行失败";
  if (category === "host-stderr" && operation === "stderr")
    return "标准错误输出";
  if (category === "renderer") return "界面脚本错误";
  if (operation === "fatal") return "致命故障恢复";
  if (category === "main" && operation === "error") return "主进程异常";
  return operation;
}

export default function DshFailuresPage() {
  const [pageSize, setPageSize] = usePageSize();
  const [draft, setDraft] = useState(initial);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<DshFailureRow[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<DshFailureDetail | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailError, setDetailError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    let active = true;
    getDshFailures(filters, page, pageSize)
      .then((result) => {
        if (active) {
          setRows(result.items);
          setTotal(result.total);
          setError("");
        }
      })
      .catch((cause) => {
        if (active) {
          setRows([]);
          setTotal(0);
          setError(cause instanceof Error ? cause.message : "日志加载失败");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, page, refresh, pageSize]);

  useEffect(() => {
    if (selected === null) return;
    let active = true;
    getDshFailure(selected)
      .then((value) => {
        if (active) setDetail(value);
      })
      .catch((cause) => {
        if (active)
          setDetailError(
            cause instanceof Error ? cause.message : "详情加载失败",
          );
      });
    return () => {
      active = false;
    };
  }, [selected]);

  const close = () => {
    dialog.current?.close();
    setSelected(null);
    setDetail(null);
  };
  const open = (id: string) => {
    setDetail(null);
    setDetailError("");
    setSelected(id);
    dialog.current?.showModal();
  };

  return (
    <div className="admin-page page-enter">
      <div className="page-title">
        <div>
          <span className="section-kicker">DSH DIAGNOSTICS</span>
          <h1>失败日志</h1>
          <p>查看客户端异步上传的失败记录。默认保留最近 7 个 UTC 自然日。</p>
        </div>
        <button
          className="secondary-action"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setRefresh((value) => value + 1);
          }}
        >
          刷新
        </button>
      </div>
      <form
        className="admin-panel failure-filters"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.from && draft.to && draft.from > draft.to) {
            setError("开始时间不能晚于结束时间");
            return;
          }
          setFilters({
            ...draft,
            from: draft.from ? new Date(draft.from).toISOString() : "",
            to: draft.to ? new Date(draft.to).toISOString() : "",
          });
          setPage(1);
          setLoading(true);
        }}
      >
        <label>
          用户
          <input
            aria-label="用户"
            value={draft.user}
            placeholder="工号或姓名"
            onChange={(event) =>
              setDraft({ ...draft, user: event.target.value })
            }
          />
        </label>
        <label>
          设备 ID
          <input
            aria-label="设备 ID"
            value={draft.device}
            onChange={(event) =>
              setDraft({ ...draft, device: event.target.value })
            }
          />
        </label>
        <label>
          版本
          <input
            aria-label="版本"
            value={draft.version}
            placeholder="0.1.7-alpha.2.20261008.2"
            onChange={(event) =>
              setDraft({ ...draft, version: event.target.value })
            }
          />
        </label>
        <label>
          错误类型
          <select
            aria-label="错误类型"
            value={draft.category}
            onChange={(event) =>
              setDraft({ ...draft, category: event.target.value })
            }
          >
            <option value="">全部类型</option>
            {categories.map((value) => (
              <option key={value} value={value}>
                {categoryLabels[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          开始时间
          <input
            aria-label="开始时间"
            type="datetime-local"
            value={draft.from}
            onChange={(event) =>
              setDraft({ ...draft, from: event.target.value })
            }
          />
        </label>
        <label>
          结束时间
          <input
            aria-label="结束时间"
            type="datetime-local"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <button className="primary-action" type="submit">
          查询
        </button>
        <button
          className="secondary-action"
          type="button"
          onClick={() => {
            setDraft(initial);
            setFilters({});
            setPage(1);
            setLoading(true);
          }}
        >
          重置
        </button>
      </form>
      {error && (
        <div className="model-form-error" role="alert">
          {error}
        </div>
      )}
      <section className="admin-panel table-panel" aria-busy={loading}>
        <div className="table-meta">
          <span>共 {total} 条失败记录</span>
          <span>发生时间倒序</span>
        </div>
        <div className="failure-table">
          <table className="data-grid">
            <thead>
              <tr>
                <th>发生时间</th>
                <th>用户</th>
                <th>版本 / 设备</th>
                <th>类型</th>
                <th>操作</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <time dateTime={row.occurredAt}>
                      {new Date(row.occurredAt).toLocaleString("zh-CN")}
                    </time>
                  </td>
                  <td>
                    {row.displayName}
                    <br />
                    <small>{row.username}</small>
                  </td>
                  <td>
                    {row.appVersion}
                    <br />
                    <small title={row.deviceId}>
                      {row.deviceId.slice(0, 12)}
                    </small>
                  </td>
                  <td>
                    <span className="failure-category" title={row.category}>
                      {categoryLabels[row.category] || row.category}
                    </span>
                  </td>
                  <td className="failure-operation" title={row.operation}>
                    {operationLabel(row.category, row.operation)}
                    <small>{row.operation}</small>
                  </td>
                  <td>
                    <button
                      className="secondary-action"
                      onClick={() => open(row.id)}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {loading && (
          <div className="empty-state" role="status">
            正在加载失败日志…
          </div>
        )}
        {!loading && rows.length === 0 && !error && (
          <div className="empty-state">
            <strong>暂无匹配的失败日志</strong>
          </div>
        )}
        <AntPagination
          onPageSizeChange={setPageSize} ariaLabel="失败日志分页"
          current={page}
          total={total}
          pageSize={pageSize}
          onChange={(value) => {
            setLoading(true);
            setPage(value);
          }}
        />
      </section>
      <dialog
        ref={dialog}
        className="failure-dialog"
        onCancel={close}
        onClose={() => {
          setSelected(null);
          setDetail(null);
        }}
        aria-labelledby="failure-title"
      >
        <div className="failure-dialog-header">
          <div>
            <h2 id="failure-title">失败详情</h2>
            <p>错误信息与关联运行上下文</p>
          </div>
          <button className="secondary-action" autoFocus onClick={close}>
            关闭
          </button>
        </div>
        <div className="failure-dialog-body">
          {detailError && (
            <div role="alert" className="model-form-error">
              {detailError}
            </div>
          )}
          {!detail && !detailError && <p role="status">正在加载详情…</p>}
          {detail && (
            <>
              <dl className="failure-metadata">
                {[
                  ["用户", detail.username],
                  ["版本", detail.appVersion],
                  ["设备", detail.deviceId],
                  ["会话", detail.sessionId || "—"],
                  [
                    "发生时间",
                    new Date(detail.occurredAt).toLocaleString("zh-CN"),
                  ],
                  [
                    "错误类型",
                    `${categoryLabels[detail.category] || detail.category} (${detail.category})`,
                  ],
                  ["操作 ID", detail.operationId || "—"],
                  ["事件 ID", detail.eventId],
                  [
                    "操作",
                    `${operationLabel(detail.category, detail.operation)} (${detail.operation})`,
                  ],
                  [
                    "耗时",
                    detail.durationMs === undefined
                      ? "—"
                      : `${detail.durationMs} ms`,
                  ],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <h3>错误信息</h3>
              <pre>{detail.error}</pre>
              <h3>操作上下文</h3>
              <pre>{detail.context.join("\n") || "无上下文"}</pre>
            </>
          )}
        </div>
        {detail && (
          <footer className="failure-dialog-footer">
            <span>下载保留原始诊断字段，便于进一步排查。</span>
            <button
              className="primary-action"
              disabled={downloading}
              onClick={async () => {
                if (!selected) return;
                setDownloading(true);
                try {
                  await downloadDshFailure(selected);
                } catch (cause) {
                  setDetailError(
                    cause instanceof Error ? cause.message : "下载失败",
                  );
                } finally {
                  setDownloading(false);
                }
              }}
            >
              {downloading ? "正在下载…" : "下载诊断日志"}
            </button>
          </footer>
        )}
      </dialog>
    </div>
  );
}
