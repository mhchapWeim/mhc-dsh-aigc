"use client";

import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Edit3,
  Filter,
  FolderOpen,
  Plus,
  Power,
  Search,
  Trash2,
} from "lucide-react";
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from "../../components/ant-pagination";
import { Modal } from "../../components/modal";
import { ModernSelect } from "../../components/modern-select";
import { usePlatform } from "../../components/platform-provider";
import type { PlatformCategory } from "../../lib/platform-state";

const emptyCategory = (order: number): PlatformCategory => ({
  id: `category-${Date.now()}`,
  name: "",
  description: "",
  color: "#2465d0",
  appCount: 0,
  enabled: true,
  order,
});

export default function CategoryManagementPage() {
  const [pageSize, setPageSize] = usePageSize();
  const { categories, dispatch, notice } = usePlatform();
  const [editing, setEditing] = useState<PlatformCategory | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("全部状态");
  const [page, setPage] = useState(1);
  const ordered = useMemo(
    () => [...categories].sort((a, b) => a.order - b.order),
    [categories],
  );
  const filtered = useMemo(
    () =>
      ordered.filter(
        (category) =>
          (!query.trim() ||
            `${category.name}${category.description}`
              .toLowerCase()
              .includes(query.trim().toLowerCase())) &&
          (status === "全部状态" || (status === "已启用") === category.enabled),
      ),
    [ordered, query, status],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = filtered.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (editing?.name.trim()) {
      try { await dispatch({ type: "save-category", category: editing }); setEditing(null); }
      catch { /* 保持弹窗以便修正 */ }
    }
  };

  return (
    <div className="admin-page page-enter">
      <div className="page-title">
        <div>
          <span className="section-kicker">PORTAL TAXONOMY</span>
          <h1>分类管理</h1>
          <p>维护应用门户的业务分类、显示顺序与启用状态。</p>
        </div>
        <button
          className="primary-action"
          type="button"
          onClick={() => setEditing(emptyCategory(categories.length + 1))}
        >
          <Plus size={18} />
          新增分类
        </button>
      </div>
      <section className="admin-panel table-panel category-table-panel">
        <div className="toolbar">
          <label className="table-search">
            <Search size={18} />
            <input
              type="search"
              aria-label="搜索分类"
              placeholder="搜索分类名称或说明"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </label>
          <div className="toolbar-filters">
            <Filter size={16} />
            <ModernSelect
              compact
              ariaLabel="分类状态筛选"
              value={status}
              options={["全部状态", "已启用", "已停用"].map((value) => ({
                value,
                label: value,
              }))}
              onChange={(value) => {
                setStatus(value);
                setPage(1);
              }}
            />
          </div>
        </div>
        <div className="table-meta">
          <span>共 {filtered.length} 个分类</span>
          <span>
            <FolderOpen size={14} />
            顺序调整会同步到应用门户分类导航
          </span>
        </div>
        <div className="table-wrap">
          <table aria-label="分类数据表格">
            <thead>
              <tr>
                <th>排序</th>
                <th>分类名称</th>
                <th>状态</th>
                <th>关联应用</th>
                <th>分类说明</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((category) => {
                const globalIndex = ordered.findIndex(
                  (item) => item.id === category.id,
                );
                return (
                  <tr key={category.id}>
                    <td>
                      <div className="category-sort-cell">
                        <strong>
                          {String(globalIndex + 1).padStart(2, "0")}
                        </strong>
                        <span>
                          <button
                            type="button"
                            aria-label={`上移${category.name}`}
                            disabled={globalIndex === 0}
                            onClick={() =>
                              dispatch({
                                type: "move-category",
                                id: category.id,
                                direction: -1,
                              })
                            }
                          >
                            <ArrowUp size={14} />
                          </button>
                          <button
                            type="button"
                            aria-label={`下移${category.name}`}
                            disabled={globalIndex === ordered.length - 1}
                            onClick={() =>
                              dispatch({
                                type: "move-category",
                                id: category.id,
                                direction: 1,
                              })
                            }
                          >
                            <ArrowDown size={14} />
                          </button>
                        </span>
                      </div>
                    </td>
                    <td>
                      <div className="category-name-cell">
                        <i style={{ background: category.color }} />
                        <strong>{category.name}</strong>
                      </div>
                    </td>
                    <td>
                      <span
                        className={`state-badge ${category.enabled ? "is-enabled" : "is-disabled"}`}
                      >
                        {category.enabled ? "已启用" : "已停用"}
                      </span>
                    </td>
                    <td>
                      <strong className="category-app-count">
                        {category.appCount}
                      </strong>{" "}
                      个应用
                    </td>
                    <td>
                      <span
                        className="role-table-description"
                        title={category.description}
                      >
                        {category.description || "暂无分类说明"}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          aria-label={`编辑${category.name}`}
                          onClick={() => setEditing(category)}
                        >
                          <Edit3 size={16} />
                        </button>
                        <button
                          type="button"
                          aria-label={`${category.enabled ? "停用" : "启用"}${category.name}`}
                          onClick={() =>
                            dispatch({
                              type: "toggle-category-status",
                              id: category.id,
                            })
                          }
                        >
                          <Power size={16} />
                        </button>
                        <button
                          className="danger-icon"
                          type="button"
                          aria-label={`删除${category.name}`}
                          onClick={() =>
                            dispatch({
                              type: "delete-category",
                              id: category.id,
                            })
                          }
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!visible.length && (
          <div className="table-empty">
            <FolderOpen size={28} />
            <strong>没有匹配的分类</strong>
            <span>请调整搜索词或状态筛选。</span>
          </div>
        )}
        <AntPagination
          onPageSizeChange={setPageSize} ariaLabel="分类分页"
          current={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          onChange={setPage}
        />
      </section>
      {notice && (
        <div className="inline-toast" role="status">
          {notice}
        </div>
      )}
      {editing && (
        <Modal
          title={
            categories.some((category) => category.id === editing.id)
              ? "编辑分类"
              : "新增分类"
          }
          onClose={() => setEditing(null)}
        >
          <form className="entity-form" onSubmit={save}>
            <div className="form-grid">
              <label>
                <span>分类名称 *</span>
                <input
                  required
                  value={editing.name}
                  onChange={(event) =>
                    setEditing({ ...editing, name: event.target.value })
                  }
                />
              </label>
              <label>
                <span>主题色</span>
                <input
                  type="color"
                  value={editing.color}
                  onChange={(event) =>
                    setEditing({ ...editing, color: event.target.value })
                  }
                />
              </label>
              <label className="form-span">
                <span>分类说明</span>
                <textarea
                  rows={4}
                  value={editing.description}
                  onChange={(event) =>
                    setEditing({ ...editing, description: event.target.value })
                  }
                />
              </label>
            </div>
            <footer className="modal-actions">
              <button type="button" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary-action" type="submit">
                保存分类
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
