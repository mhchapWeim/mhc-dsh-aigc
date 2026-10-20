"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FilePlus2,
  GitBranch,
  RotateCcw,
} from "lucide-react";
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from "../../components/ant-pagination";
import { Modal } from "../../components/modal";
import { ModernSelect } from "../../components/modern-select";
import { DirectoryUserPicker } from "../../components/directory-user-picker";
import { usePlatform } from "../../components/platform-provider";
import { canResubmitPublication, type PublicationStatus } from "../../lib/platform-state";
import {
  getMyPublications,
  getPublicationOptions,
  getPublicationAccessOptions,
  hasBackend,
  resubmitPublication,
  submitPublication,
  type BackendPublication,
  type PublicationOption,
  type PublicationAccessOptions,
} from "../../lib/api-client";

type FormState = {
  appName: string;
  category: string;
  summary: string;
  repositoryUrl: string;
  branch: string;
  commitSha: string;
  version: string;
  environment: string;
  accessMode: "All" | "Subjects";
  accessibleUserIds: string[];
};
const emptyForm = (): FormState => ({
  appName: "",
  category: "智慧服务",
  summary: "",
  repositoryUrl: "",
  branch: "main",
  commitSha: "",
  version: "",
  environment: "Production",
  accessMode: "All",
  accessibleUserIds: [],
});
const statusLabel = (status: string): PublicationStatus => ({
  Draft: "草稿", Reviewing: "审核中", Publishing: "发布中", Approved: "已通过",
  Rejected: "已退回", Failed: "发布失败",
}[status] as PublicationStatus ?? "草稿");

export default function PublicationRequestsPage() {
  const [pageSize, setPageSize] = usePageSize();
  const {
    currentUserId,
    users,
    publicationRequests,
    categories,
    dispatch,
    notice,
  } = usePlatform();
  const [form, setForm] = useState<FormState | null>(null);
  const [page, setPage] = useState(1);
  const [backendRequests, setBackendRequests] = useState<BackendPublication[] | null>(null);
  const [backendCategories, setBackendCategories] = useState<PublicationOption[]>([]);
  const [accessOptions, setAccessOptions] = useState<PublicationAccessOptions>({ users: [], departments: [], roles: [] });
  const [backendNotice, setBackendNotice] = useState("");
  const [backendEnabled, setBackendEnabled] = useState(false);
  const loadBackend = async () => {
    const [requests, options, access] = await Promise.all([getMyPublications(), getPublicationOptions(), getPublicationAccessOptions()]);
    setBackendRequests(requests.items);
    setBackendCategories(options);
    setAccessOptions(access);
  };
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBackendEnabled(hasBackend && Boolean(localStorage.getItem("aigc_hub_access_token")));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!backendEnabled) return;
    const timer = window.setTimeout(() => {
      loadBackend().catch((error: Error) => setBackendNotice(error.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [backendEnabled]);
  const mine = useMemo(() => backendRequests
    ? backendRequests.map((request) => ({
        id: request.id, appName: request.appName, category: request.category, summary: request.summary,
        accessUrl: request.accessUrl, applicantId: currentUserId, applicantName: request.applicantName,
        applicantDepartment: request.applicantDepartment, status: statusLabel(request.status),
        currentNodeId: request.currentNodeKey, currentNodeName: request.currentNodeName,
        currentAssigneeIds: [], currentCandidateGroups: [],
        submittedAt: new Date(request.createdAt).toLocaleString("zh-CN"),
        updatedAt: new Date(request.updatedAt).toLocaleString("zh-CN"),
        reviewComment: request.reviewComment, processDefinitionId: "backend", processInstanceId: request.id,
      }))
    : publicationRequests.filter((request) => request.applicantId === currentUserId),
    [backendRequests, currentUserId, publicationRequests]);
  const pageCount = Math.max(1, Math.ceil(mine.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = mine.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );
  const currentUser = users.find((user) => user.id === currentUserId);
  const categoryOptions = backendRequests
    ? backendCategories.map((category) => ({ value: category.id, label: category.name, description: category.description }))
    : categories.filter((category) => category.enabled).map((category) => ({
        value: category.name, label: category.name, description: category.description,
      }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form?.appName.trim() || !form.summary.trim() || !form.repositoryUrl.trim() ||
        !form.branch.trim() || !form.commitSha.trim() || !form.version.trim() ||
        (form.accessMode === "Subjects" && !form.accessibleUserIds.length))
      return;
    if (backendEnabled) {
      try {
        await submitPublication({
          appName: form.appName, categoryId: form.category, summary: form.summary,
          repositoryUrl: form.repositoryUrl, branch: form.branch, commitSha: form.commitSha,
          version: form.version, environment: form.environment, accessMode: form.accessMode,
          accessSubjects: form.accessibleUserIds.map((subjectId) => ({ subjectType: "User", subjectId })),
        });
        setForm(null);
        setBackendNotice("发布申请已提交，流程已进入审核节点");
        await loadBackend();
      } catch (error) { setBackendNotice(error instanceof Error ? error.message : "提交失败"); }
    } else {
      dispatch({ type: "submit-publication", actorId: currentUserId, request: {
        id: `pub-${Date.now()}`, appName: form.appName, category: form.category,
        summary: form.summary, accessUrl: "",
      } });
      setForm(null);
    }
  };
  const resubmit = async (id: string) => {
    if (!backendEnabled) { dispatch({ type: "resubmit-publication", id, actorId: currentUserId }); return; }
    try { await resubmitPublication(id); setBackendNotice("申请已重新提交"); await loadBackend(); }
    catch (error) { setBackendNotice(error instanceof Error ? error.message : "重新提交失败"); }
  };

  return (
    <div className="admin-page page-enter publication-page">
      <div className="page-title">
        <div>
          <span className="section-kicker">APPLICATION DELIVERY</span>
          <h1>应用发布申请</h1>
          <p>提交应用资料并跟踪流程引擎中的审核进度。</p>
        </div>
        <button
          className="primary-action"
          type="button"
          onClick={() => setForm({ ...emptyForm(), category: categoryOptions[0]?.value ?? "智慧服务" })}
        >
          <FilePlus2 size={18} />
          新建发布申请
        </button>
      </div>
      <section className="publication-summary" aria-label="申请概览">
        <div>
          <strong>{mine.length}</strong>
          <span>我的申请</span>
        </div>
        <div>
          <strong>
            {mine.filter((request) => request.status === "审核中").length}
          </strong>
          <span>审核中</span>
        </div>
        <div>
          <strong>
            {mine.filter((request) => request.status === "已通过").length}
          </strong>
          <span>已通过</span>
        </div>
        <div>
          <GitBranch size={18} />
          <span>由应用发布流程自动流转</span>
        </div>
      </section>
      <section
        className="admin-panel publication-list"
        aria-label="我的发布申请"
      >
        <header className="panel-heading">
          <div>
            <h2>我的发布申请</h2>
            <p>仅显示当前登录人发起的申请</p>
          </div>
        </header>
        {visible.map((request) => (
          <article className="publication-row" key={request.id}>
            <span className={`publication-icon status-${request.status}`}>
              <FilePlus2 size={19} />
            </span>
            <div className="publication-main">
              <div>
                <h3>{request.appName}</h3>
                <span className={`workflow-status status-${request.status}`}>
                  {request.status}
                </span>
              </div>
              <p>{request.summary}</p>
              <small>
                {request.category} · {request.submittedAt}
              </small>
            </div>
            <div
              className="workflow-progress"
              aria-label={`${request.appName}流程进度`}
            >
              <span className="is-done">
                <CheckCircle2 size={15} />
                提交申请
              </span>
              <ArrowRight size={14} />
              <span
                className={
                  request.status === "审核中"
                    ? "is-current"
                    : request.status === "已退回"
                      ? "is-returned"
                      : "is-done"
                }
              >
                {request.status === "已退回" ? (
                  <RotateCcw size={15} />
                ) : (
                  <Clock3 size={15} />
                )}{" "}
                {request.currentNodeName}
              </span>
              {canResubmitPublication(currentUser, request) && (
                <button
                  className="resubmit-button"
                  type="button"
                  aria-label={`重新提交${request.appName}`}
                  onClick={() => void resubmit(request.id)}
                >
                  <RotateCcw size={14} />
                  重新提交
                </button>
              )}
            </div>
          </article>
        ))}
        {!mine.length && (
          <div className="table-empty">
            <FilePlus2 size={28} />
            <strong>还没有发布申请</strong>
            <span>创建申请后，流程进度会显示在这里。</span>
          </div>
        )}
        <AntPagination
          onPageSizeChange={setPageSize} ariaLabel="发布申请分页"
          current={currentPage}
          pageSize={pageSize}
          total={mine.length}
          onChange={setPage}
        />
      </section>
      {(backendNotice || notice) && (
        <div className="inline-toast" role="status">
          {backendNotice || notice}
        </div>
      )}
      {form && (
        <Modal title="新建发布申请" onClose={() => setForm(null)}>
          <form className="entity-form publication-form" onSubmit={submit}>
            <div className="form-grid">
              <label>
                <span>应用名称 *</span>
                <input
                  aria-label="应用名称"
                  required
                  value={form.appName}
                  onChange={(event) =>
                    setForm({ ...form, appName: event.target.value })
                  }
                />
              </label>
              <div className="form-field">
                <span>应用分类</span>
                <ModernSelect
                  ariaLabel="应用分类"
                  value={form.category}
                  options={categoryOptions}
                  onChange={(category) => setForm({ ...form, category })}
                />
              </div>
              <label className="form-span">
                <span>应用简介 *</span>
                <textarea
                  aria-label="应用简介"
                  required
                  rows={4}
                  value={form.summary}
                  onChange={(event) =>
                    setForm({ ...form, summary: event.target.value })
                  }
                />
              </label>
              <label className="form-span">
                <span>代码仓库 *</span>
                <input
                  aria-label="代码仓库"
                  required
                  type="url"
                  value={form.repositoryUrl}
                  onChange={(event) =>
                    setForm({ ...form, repositoryUrl: event.target.value })
                  }
                />
                <small>请填写代码审核人员可以访问的 HTTPS 仓库地址。</small>
              </label>
              <label>
                <span>分支 *</span>
                <input aria-label="分支" required value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} />
              </label>
              <label>
                <span>Commit SHA *</span>
                <input aria-label="Commit SHA" required value={form.commitSha} onChange={(event) => setForm({ ...form, commitSha: event.target.value })} />
              </label>
              <label>
                <span>发布版本 *</span>
                <input aria-label="发布版本" required value={form.version} onChange={(event) => setForm({ ...form, version: event.target.value })} />
              </label>
              <div className="form-field">
                <span>部署环境</span>
                <ModernSelect ariaLabel="部署环境" value={form.environment} options={["Test", "Staging", "Production"].map((value) => ({ value, label: value }))} onChange={(environment) => setForm({ ...form, environment })} />
              </div>
              <div className="form-field form-span">
                <span>可访问范围</span>
                <ModernSelect ariaLabel="可访问范围" value={form.accessMode} options={[{ value: "All", label: "所有已登录用户" }, { value: "Subjects", label: "指定可访问人" }]} onChange={(accessMode) => setForm({ ...form, accessMode: accessMode as "All" | "Subjects", accessibleUserIds: accessMode === "All" ? [] : form.accessibleUserIds })} />
              </div>
              {form.accessMode === "Subjects" && <div className="form-field form-span">
                <span>可访问人 *</span>
                <DirectoryUserPicker users={accessOptions.users} selectedIds={form.accessibleUserIds} onChange={(accessibleUserIds) => setForm({ ...form, accessibleUserIds })} />
              </div>}
              <p className="form-span publication-url-note">部署后的访问地址将在第二个审批节点完成后，由部署服务回调写入。</p>
            </div>
            <footer className="modal-actions">
              <button type="button" onClick={() => setForm(null)}>
                取消
              </button>
              <button className="primary-action" type="submit">
                提交发布申请
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </div>
  );
}
