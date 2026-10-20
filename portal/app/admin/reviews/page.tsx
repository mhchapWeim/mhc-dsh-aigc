'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, ClipboardCheck, Clock3, GitBranch, ShieldCheck, Undo2 } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { ModernSelect } from '../../components/modern-select';
import { usePlatform } from '../../components/platform-provider';
import { canReviewPublication, type PublicationRequest, type PublicationStatus } from '../../lib/platform-state';
import { completeWorkflowTask, getReviewablePublications, hasBackend, type BackendPublication } from '../../lib/api-client';

type ReviewItem = PublicationRequest & { taskId?: string; backendAllowed?: boolean };
const statusLabel = (status: string): PublicationStatus => ({
  Draft: '草稿', Reviewing: '审核中', Publishing: '发布中', Approved: '已通过',
  Rejected: '已退回', Failed: '发布失败',
}[status] as PublicationStatus ?? '草稿');

export default function PublicationReviewsPage() {
  const [pageSize, setPageSize] = usePageSize();
  const { currentUserId, users, publicationRequests, dispatch, notice } = usePlatform();
  const [status, setStatus] = useState('全部状态');
  const [page, setPage] = useState(1);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [backendRequests, setBackendRequests] = useState<BackendPublication[] | null>(null);
  const [backendNotice, setBackendNotice] = useState('');
  const [backendEnabled, setBackendEnabled] = useState(false);
  const loadBackend = async () => setBackendRequests((await getReviewablePublications()).items);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setBackendEnabled(hasBackend && Boolean(localStorage.getItem('aigc_hub_access_token')));
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
  const currentUser = users.find((user) => user.id === currentUserId);
  const requests = useMemo<ReviewItem[]>(() => {
    const source: ReviewItem[] = backendRequests ? backendRequests.map((request) => ({
      id: request.id, appName: request.appName, category: request.category, summary: request.summary,
      accessUrl: request.accessUrl, applicantId: '', applicantName: request.applicantName,
      applicantDepartment: request.applicantDepartment, status: statusLabel(request.status),
      currentNodeId: request.currentNodeKey, currentNodeName: request.currentNodeName,
      currentAssigneeIds: [], currentCandidateGroups: [],
      submittedAt: new Date(request.createdAt).toLocaleString('zh-CN'),
      updatedAt: new Date(request.updatedAt).toLocaleString('zh-CN'), reviewComment: request.reviewComment,
      processDefinitionId: 'backend', processInstanceId: request.id, taskId: request.taskId,
      backendAllowed: request.availableActions.some((action) => action.code === 'approve'),
    })) : publicationRequests;
    return source.filter((request) => status === '全部状态' || request.status === status);
  }, [backendRequests, publicationRequests, status]);
  const pageCount = Math.max(1, Math.ceil(requests.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = requests.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pendingCount = backendRequests ? backendRequests.length : publicationRequests.filter((request) => canReviewPublication(currentUser, request)).length;
  const review = async (request: ReviewItem, decision: '通过' | '退回') => {
    const comment = comments[request.id]?.trim() || (decision === '通过' ? '审核通过' : '请修改后重新提交');
    if (backendEnabled && request.taskId) {
      try {
        await completeWorkflowTask(request.taskId, decision === '通过' ? 'approve' : 'reject', comment);
        setBackendNotice(decision === '通过' ? '审核已通过，应用已进入发布节点' : '申请已退回');
        await loadBackend();
      } catch (error) { setBackendNotice(error instanceof Error ? error.message : '审核失败'); }
      return;
    }
    dispatch({ type: 'review-publication', id: request.id, actorId: currentUserId, decision, comment });
  };

  return <div className="admin-page page-enter publication-page">
    <div className="page-title"><div><span className="section-kicker">WORKFLOW INBOX</span><h1>应用发布审核</h1><p>处理流程引擎分配给当前用户或候选用户组的发布任务。</p></div><span className="pending-chip"><Clock3 size={16}/><strong>{pendingCount}</strong> 项待我处理</span></div>
    <section className="review-rule-banner"><ShieldCheck size={20}/><div><strong>流程权限已启用</strong><p>只有当前节点的直接处理人或候选用户组成员可以执行审核；其他任务保持只读。</p></div><GitBranch size={22}/></section>
    <section className="admin-panel publication-list review-list" aria-label="发布审核列表">
      <header className="panel-heading"><div><h2>发布审核任务</h2><p>权限来自当前流程节点配置</p></div><ModernSelect compact ariaLabel="审核状态筛选" value={status} options={['全部状态','审核中','已通过','已退回'].map((value) => ({ value, label: value }))} onChange={(value) => { setStatus(value); setPage(1); }}/></header>
      {visible.map((request) => { const allowed = backendRequests ? Boolean(request.backendAllowed) : canReviewPublication(currentUser, request); return <article className="review-row" key={request.id}>
        <div className="review-row__heading"><span className={`publication-icon status-${request.status}`}><ClipboardCheck size={19}/></span><div><div><h3>{request.appName}</h3><span className={`workflow-status status-${request.status}`}>{request.status}</span></div><p>{request.summary}</p><small>申请人：{request.applicantName} · {request.applicantDepartment} · {request.submittedAt}</small></div></div>
        <div className="review-node"><span><GitBranch size={16}/>{request.currentNodeName}</span><small>{request.currentAssigneeIds.length ? '指定处理人' : request.currentCandidateGroups.length ? '候选用户组' : '流程已结束'}</small></div>
        <div className="review-actions">{allowed ? <><label><span>审核意见</span><textarea aria-label={`${request.appName}审核意见`} rows={2} value={comments[request.id] || ''} onChange={(event) => setComments({ ...comments, [request.id]: event.target.value })}/></label><div><button className="secondary-danger" type="button" aria-label={`退回${request.appName}`} onClick={() => void review(request, '退回')}><Undo2 size={16}/>退回</button><button className="primary-action" type="button" aria-label={`通过${request.appName}`} onClick={() => void review(request, '通过')}><Check size={16}/>通过</button></div></> : request.status === '审核中' ? <span className="readonly-hint"><ShieldCheck size={16}/>不在当前处理范围</span> : <span className="readonly-hint"><CheckCircle2 size={16}/>流程已处理</span>}</div>
      </article>})}
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="发布审核分页" current={currentPage} pageSize={pageSize} total={requests.length} onChange={setPage} />
    </section>
    {(backendNotice || notice) && <div className="inline-toast" role="status">{backendNotice || notice}</div>}
  </div>;
}
