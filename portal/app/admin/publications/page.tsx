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
import { GiteaRepositoryPicker } from "../../components/gitea-repository-picker";
import { usePlatform } from "../../components/platform-provider";
import { canResubmitPublication, type PublicationStatus } from "../../lib/platform-state";
import { AccessRequestFormModal } from "../../components/access-request-form";
import { AccessRequestDetailModal, accessStatusText } from "./access-requests";
import "./requests.css";
import {
  getMyAccessRequests,
  getMyPublications,
  getPublicationOptions,
  getPublicationAccessOptions,
  hasBackend,
  resubmitPublication,
  submitPublication,
  type AccessRequestItem,
  type BackendPublication,
  type PublicationOption,
  type PublicationAccessOptions,
} from "../../lib/api-client";

type FormState = {
  codeSource?: import("../../lib/integrations").CodeSelection;
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
  const [formError, setFormError] = useState("");
  const [backendEnabled, setBackendEnabled] = useState(false);
  const [picker, setPicker] = useState(false);
  const [accessForm, setAccessForm] = useState(false);
  const [accessItems, setAccessItems] = useState<AccessRequestItem[]>([]);
  const [accessDetailId, setAccessDetailId] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<"all" | "publication" | "access">("all");
  const loadBackend = async () => {
    const [requests, options, access, mineAccess] = await Promise.all([
      getMyPublications(), getPublicationOptions(), getPublicationAccessOptions(), getMyAccessRequests(),
    ]);
    setBackendRequests(requests.items);
    setBackendCategories(options);
    setAccessOptions(access);
    setAccessItems(mineAccess);
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
  const currentUser = users.find((user) => user.id === currentUserId);
  const rows = useMemo(() => {
    const publications = mine.map((request, index) => ({
      id: request.id,
      kind: "publication" as const,
      title: request.appName,
      summary: request.summary,
      meta: `${request.category} · ${request.submittedAt}`,
      status: request.status,
      node: request.currentNodeName,
      sort: backendRequests ? Date.parse(backendRequests.find(item => item.id === request.id)?.createdAt ?? "") || 0 : mine.length - index,
      canResubmit: backendRequests ? request.status === "已退回" || request.status === "发布失败" : canResubmitPublication(currentUser, request),
    }));
    const accesses = accessItems.map(item => ({
      id: item.id,
      kind: "access" as const,
      title: item.appName,
      summary: item.reason,
      meta: `${item.requestNo} · ${new Date(item.createdAt).toLocaleString("zh-CN")}`,
      status: accessStatusText[item.status] ?? item.status,
      node: item.currentNodeName,
      sort: Date.parse(item.createdAt) || 0,
      canResubmit: false,
    }));
    return [...publications, ...accesses]
      .filter(row => kindFilter === "all" || row.kind === kindFilter)
      .sort((left, right) => right.sort - left.sort);
  }, [accessItems, backendRequests, currentUser, kindFilter, mine]);
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const categoryOptions = backendRequests
    ? backendCategories.map((category) => ({ value: category.id, label: category.parentId ? `${backendCategories.find(x => x.id === category.parentId)?.name || ""} / ${category.name}` : category.name, description: category.description }))
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
          codeSource: form.codeSource,
          appName: form.appName, categoryId: form.category, summary: form.summary,
          repositoryUrl: form.repositoryUrl, branch: form.branch, commitSha: form.commitSha,
          version: form.version, environment: form.environment, accessMode: form.accessMode,
          accessSubjects: form.accessibleUserIds.map((subjectId) => ({ subjectType: "User", subjectId })),
        });
        setForm(null);
        setBackendNotice("发布申请已提交，流程已进入审核节点");
        await loadBackend();
      } catch (error) { setFormError(error instanceof Error ? error.message : "提交失败"); }
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

  const openPublication = () => {
    setPicker(false);
    setFormError("");
    setForm({ ...emptyForm(), category: categoryOptions[0]?.value ?? "智慧服务" });
  };
  const openAccess = () => {
    setPicker(false);
    if (!backendEnabled) {
      setBackendNotice("访问申请需要连接中台服务后再提交");
      return;
    }
    setAccessForm(true);
  };

  return (
    <div className="admin-page page-enter publication-page admin-stack">
      <div className="page-title">
        <div>
          <span className="section-kicker">APPLICATION DELIVERY</span>
          <h1>申请管理</h1>
          <p>统一查看发布申请和访问申请。新建时先选择申请类型，审批流程由管理员绑定。</p>
        </div>
        <button className="primary-action" type="button" onClick={() => setPicker(true)}>
          <FilePlus2 size={18} />
          新建申请
        </button>
      </div>
      <section className="publication-summary" aria-label="申请概览">
        <div>
          <strong>{mine.length + accessItems.length}</strong>
          <span>我的申请</span>
        </div>
        <div>
          <strong>{mine.filter((request) => request.status === "审核中").length + accessItems.filter((item) => item.status === "Reviewing").length}</strong>
          <span>审核中</span>
        </div>
        <div>
          <strong>{mine.filter((request) => request.status === "已通过").length + accessItems.filter((item) => item.status === "Approved").length}</strong>
          <span>已通过</span>
        </div>
        <div>
          <GitBranch size={18} />
          <span>发布与访问共用流程和待办</span>
        </div>
      </section>
      <div className="admin-panel request-filters">
        <label>
          申请类型
          <select aria-label="申请类型" value={kindFilter} onChange={event => { setKindFilter(event.target.value as "all" | "publication" | "access"); setPage(1); }}>
            <option value="all">全部申请</option>
            <option value="publication">发布申请</option>
            <option value="access">访问申请</option>
          </select>
        </label>
      </div>
      <section className="admin-panel publication-list" aria-label="我的申请">
        <header className="panel-heading">
          <div>
            <h2>我的申请</h2>
            <p>发布申请和访问申请按提交时间排在一起</p>
          </div>
        </header>
        {visible.map((request) => (
          <article className="publication-row" key={`${request.kind}-${request.id}`}>
            <span className={`publication-icon status-${request.status}`}>
              <FilePlus2 size={19} />
            </span>
            <div className="publication-main">
              <div>
                <h3>{request.title}</h3>
                <span className="workflow-status request-type">{request.kind === "publication" ? "发布申请" : "访问申请"}</span>
                <span className={`workflow-status status-${request.status}`}>{request.status}</span>
              </div>
              <p>{request.summary}</p>
              <small>{request.meta}</small>
            </div>
            <div className="workflow-progress" aria-label={`${request.title}流程进度`}>
              <span className="is-done"><CheckCircle2 size={15} />提交申请</span>
              <ArrowRight size={14} />
              <span className={request.status === "审核中" ? "is-current" : request.status === "已退回" || request.status === "已驳回" ? "is-returned" : "is-done"}>
                {request.status === "已退回" || request.status === "已驳回" ? <RotateCcw size={15} /> : <Clock3 size={15} />} {request.node}
              </span>
              {request.canResubmit && (
                <button className="resubmit-button" type="button" aria-label={`重新提交${request.title}`} onClick={() => void resubmit(request.id)}>
                  <RotateCcw size={14} />重新提交
                </button>
              )}
              {request.kind === "access" && (
                <button className="secondary-action" type="button" onClick={() => setAccessDetailId(request.id)}>查看</button>
              )}
            </div>
          </article>
        ))}
        {!rows.length && (
          <div className="table-empty">
            <FilePlus2 size={28} />
            <strong>还没有申请</strong>
            <span>新建申请后，发布和访问记录会一起显示在这里。</span>
          </div>
        )}
        <AntPagination onPageSizeChange={setPageSize} ariaLabel="申请分页" current={currentPage} pageSize={pageSize} total={rows.length} onChange={setPage} />
      </section>
      {(backendNotice || notice) && (
        <div className="inline-toast" role="status">
          {backendNotice || notice}
        </div>
      )}
      {form && (
        <Modal title="新建发布申请" onClose={() => setForm(null)}>
          <form className="entity-form publication-form" aria-label="发布申请表单" tabIndex={0} onSubmit={submit}>
            <div className="form-grid">
              {backendEnabled && <GiteaRepositoryPicker onChange={selection => setForm(previous => previous ? { ...previous,
                codeSource: selection?.source, repositoryUrl: selection?.repository.html_url ?? "", branch: selection?.branch ?? "", commitSha: selection?.commit.sha ?? "",
                appName: previous.appName || selection?.repository.name || "", summary: previous.summary || selection?.repository.description || ""
              } : previous)} />}
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
                  readOnly={Boolean(form.codeSource)}
                  value={form.repositoryUrl}
                  onChange={(event) =>
                    setForm({ ...form, repositoryUrl: event.target.value })
                  }
                />
                <small>请填写代码审核人员可以访问的 HTTPS 仓库地址。</small>
              </label>
              <label>
                <span>分支 *</span>
                <input aria-label="分支" required readOnly={Boolean(form.codeSource)} value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} />
              </label>
              <label>
                <span>Commit SHA *</span>
                <input aria-label="Commit SHA" required readOnly={Boolean(form.codeSource)} value={form.commitSha} onChange={(event) => setForm({ ...form, commitSha: event.target.value })} />
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
            {/* Submit failures must stay inside the dialog: the page toast sits
                below the modal scrim and would be hidden behind it. */}
            {formError && <p className="publication-form-error" role="alert">{formError}</p>}
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
      {picker && (
        <Modal title="选择申请类型" onClose={() => setPicker(false)}>
          <div className="request-kind-list">
            <button className="request-kind" type="button" aria-label="发布申请" onClick={openPublication}>
              <strong>发布申请</strong>
              <span>提交应用代码、版本和访问范围，沿用现有发布表单与审核流程。</span>
            </button>
            <button className="request-kind" type="button" aria-label="访问申请" onClick={openAccess}>
              <strong>访问申请</strong>
              <span>选择还不能访问的已发布应用，并填写申请原因。</span>
            </button>
          </div>
        </Modal>
      )}
      {accessForm && <AccessRequestFormModal onClose={() => setAccessForm(false)} onSubmitted={() => { setBackendNotice("访问申请已提交，审批人由绑定流程决定"); void loadBackend(); }} />}
      {accessDetailId && <AccessRequestDetailModal id={accessDetailId} onClose={() => setAccessDetailId(null)} />}
    </div>
  );
}
