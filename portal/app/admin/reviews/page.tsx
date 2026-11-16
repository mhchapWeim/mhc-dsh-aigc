'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, CheckCircle2, ClipboardCheck, Clock3, ExternalLink, Eye, GitBranch, RotateCcw, ShieldCheck, Undo2 } from 'lucide-react';
import { usePageSize } from '../../components/use-page-size';
import { AntPagination } from '../../components/ant-pagination';
import { ModernSelect } from '../../components/modern-select';
import { Modal } from '../../components/modal';
import { usePlatform } from '../../components/platform-provider';
import { canReviewPublication, type PublicationRequest, type PublicationStatus } from '../../lib/platform-state';
import { completeWorkflowTask, getReviewablePublications, hasBackend, type BackendPublication } from '../../lib/api-client';
import './reviews.css';

type AuditSummary = NonNullable<BackendPublication['audit']>;

type ReviewItem = PublicationRequest & {
  taskId?: string;
  backendAllowed?: boolean;
  requestNo?: string;
  repositoryUrl?: string;
  branch?: string;
  commitSha?: string;
  version?: string;
  environment?: string;
  accessScope?: string;
  reviewerName?: string;
  taskName?: string | null;
  candidateScope?: string;
  assigneeId?: string | null;
  audit?: AuditSummary | null;
};
const statusLabel = (status: string): PublicationStatus => ({
  Draft: '草稿', Reviewing: '审核中', Publishing: '发布中', Approved: '已通过',
  Rejected: '已退回', Failed: '发布失败',
}[status] as PublicationStatus ?? '草稿');

const blank = (value?: string) => (value && value.trim() ? value : '—');

/**
 * The server reports how the pending node is assigned. Inferring it from local arrays is
 * what produced the wrong "流程已结束" while a task was still waiting for review.
 *
 * Returns null when the node no longer waits on a person: the status badge and node name
 * already say why, so a second line would only restate them.
 */
const handleScope = (request: ReviewItem): string | null => {
  if (request.candidateScope) return request.candidateScope;
  // Demo state (no backend) only carries candidate group ids.
  if (request.currentAssigneeIds.length) return '指定处理人';
  if (request.currentCandidateGroups.length) return '候选用户组';
  return request.status === '审核中' ? '待分配' : null;
};

export default function PublicationReviewsPage() {
  const [pageSize, setPageSize] = usePageSize();
  const { currentUserId, users, publicationRequests, dispatch, notice } = usePlatform();
  const [status, setStatus] = useState('全部状态');
  const [page, setPage] = useState(1);
  const [comments, setComments] = useState<Record<string, string>>({});
  const [backendRequests, setBackendRequests] = useState<BackendPublication[] | null>(null);
  const [backendNotice, setBackendNotice] = useState('');
  const [backendEnabled, setBackendEnabled] = useState(false);
  // Only one detail dialog at a time; the list itself stays on one compact line per task.
  const [detail, setDetail] = useState<ReviewItem | null>(null);
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
      requestNo: request.requestNo, repositoryUrl: request.repositoryUrl, branch: request.branch,
      commitSha: request.commitSha, version: request.version, environment: request.environment,
      accessScope: request.accessScope ?? (request.accessMode === 'Subjects' ? '指定可访问人' : '所有已登录用户'),
      reviewerName: request.reviewerName, taskName: request.taskName,
      candidateScope: request.candidateScope ?? '', assigneeId: request.assigneeId ?? null,
      audit: request.audit ?? null,
    })) : publicationRequests;
    return source.filter((request) => status === '全部状态' || request.status === status);
  }, [backendRequests, publicationRequests, status]);
  const pageCount = Math.max(1, Math.ceil(requests.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visible = requests.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const pendingCount = backendRequests ? backendRequests.length : publicationRequests.filter((request) => canReviewPublication(currentUser, request)).length;
  const allowedFor = (request: ReviewItem) => backendRequests ? Boolean(request.backendAllowed) : canReviewPublication(currentUser, request);
  const review = async (request: ReviewItem, decision: '通过' | '退回') => {
    const comment = comments[request.id]?.trim() || (decision === '通过' ? '审核通过' : '请修改后重新提交');
    if (backendEnabled && request.taskId) {
      try {
        await completeWorkflowTask(request.taskId, decision === '通过' ? 'approve' : 'reject', comment);
        setBackendNotice(decision === '通过' ? '审核已通过，应用已进入发布节点' : '申请已退回');
        setDetail(null);
        await loadBackend();
      } catch (error) { setBackendNotice(error instanceof Error ? error.message : '审核失败'); }
      return;
    }
    dispatch({ type: 'review-publication', id: request.id, actorId: currentUserId, decision, comment });
    setDetail(null);
  };

  return <div className="admin-page page-enter publication-page">
    <div className="page-title"><div><span className="section-kicker">WORKFLOW INBOX</span><h1>应用发布审核</h1><p>处理流程引擎分配给当前用户或候选用户组的发布任务。</p></div><span className="pending-chip"><Clock3 size={16}/><strong>{pendingCount}</strong> 项待我处理</span></div>
    <section className="review-rule-banner"><ShieldCheck size={20}/><div><strong>流程权限已启用</strong><p>只有当前节点的直接处理人或候选用户组成员可以执行审核；其他任务保持只读。</p></div><GitBranch size={22}/></section>
    <section className="admin-panel publication-list review-list" aria-label="发布审核列表">
      <header className="panel-heading"><div><h2>发布审核任务</h2><p>权限来自当前流程节点配置</p></div><ModernSelect compact ariaLabel="审核状态筛选" value={status} options={['全部状态','审核中','已通过','已退回','发布中','发布失败'].map((value) => ({ value, label: value }))} onChange={(value) => { setStatus(value); setPage(1); }}/></header>
      {visible.map((request) => {
        const allowed = allowedFor(request);
        return <article className="review-queue-row" key={request.id}>
          <span className={`publication-icon status-${request.status}`}><ClipboardCheck size={19}/></span>
          <div className="review-queue-row__main">
            <div>
              <h3>{request.appName}</h3>
              <span className={`workflow-status status-${request.status}`}>{request.status}</span>
              {request.version && <span className="review-queue-row__version">v{request.version}</span>}
            </div>
            <p>{request.summary}</p>
            <small>{request.requestNo ? `${request.requestNo} · ` : ''}申请人：{request.applicantName} · {request.applicantDepartment} · {request.submittedAt}</small>
          </div>
          <div className="review-queue-row__node">
            <span><GitBranch size={15}/>{request.currentNodeName}</span>
            {handleScope(request) && <small>{handleScope(request)}</small>}
          </div>
          <div className="review-queue-row__actions">
            <button className="detail-button" type="button" aria-label={`查看${request.appName}详情`} onClick={() => setDetail(request)}><Eye size={15}/>详情</button>
            {allowed
              ? <><button className="secondary-danger" type="button" aria-label={`退回${request.appName}`} onClick={() => void review(request, '退回')}><Undo2 size={15}/>退回</button><button className="primary-action" type="button" aria-label={`通过${request.appName}`} onClick={() => void review(request, '通过')}><Check size={15}/>通过</button></>
              : request.status === '审核中'
                ? <span className="readonly-hint"><ShieldCheck size={15}/>不在当前处理范围</span>
                : <span className="readonly-hint">{request.status === '已退回' ? <RotateCcw size={15}/> : <CheckCircle2 size={15}/>}{request.status === '已退回' ? '已退回修改' : '流程已处理'}</span>}
          </div>
        </article>;
      })}
      {!visible.length && <div className="table-empty"><ClipboardCheck size={28}/><strong>当前没有待处理任务</strong><span>新提交的申请会在自动刷新后出现在这里。</span></div>}
      <AntPagination onPageSizeChange={setPageSize} ariaLabel="发布审核分页" current={currentPage} pageSize={pageSize} total={requests.length} onChange={setPage}/>
    </section>
    {(backendNotice || notice) && <div className="inline-toast" role="status">{backendNotice || notice}</div>}
    {detail && <Modal title={`${detail.appName} · 申请详情`} className="review-detail-modal" onClose={() => setDetail(null)}
      footer={<>
        <button type="button" onClick={() => setDetail(null)}>关闭</button>
        {allowedFor(detail) && <button className="secondary-danger" type="button" aria-label={`退回${detail.appName}`} onClick={() => void review(detail, '退回')}><Undo2 size={16}/>退回</button>}
        {allowedFor(detail) && <button className="primary-action" type="button" aria-label={`通过${detail.appName}`} onClick={() => void review(detail, '通过')}><Check size={16}/>通过</button>}
      </>}>
      <div className="review-detail">
        <header className="review-detail__head">
          <div>
            <span className={`workflow-status status-${detail.status}`}>{detail.status}</span>
            {detail.requestNo && <span className="review-detail__no">{detail.requestNo}</span>}
          </div>
          <p>{detail.summary}</p>
        </header>
        <dl className="review-detail__grid">
          <div><dt>申请人</dt><dd>{blank(detail.applicantName)}</dd></div>
          <div><dt>所属部门</dt><dd>{blank(detail.applicantDepartment)}</dd></div>
          <div><dt>提交时间</dt><dd>{blank(detail.submittedAt)}</dd></div>
          <div><dt>应用分类</dt><dd>{blank(detail.category)}</dd></div>
          <div className="is-span"><dt>代码仓库</dt><dd className="is-wrap">{blank(detail.repositoryUrl)}</dd></div>
          <div><dt>分支</dt><dd>{blank(detail.branch)}</dd></div>
          <div><dt>发布版本</dt><dd>{blank(detail.version)}</dd></div>
          <div className="is-span"><dt>Commit</dt><dd className="is-wrap is-mono">{blank(detail.commitSha)}</dd></div>
          <div><dt>部署环境</dt><dd>{blank(detail.environment)}</dd></div>
          <div><dt>可访问范围</dt><dd>{blank(detail.accessScope)}</dd></div>
          <div className="is-span"><dt>访问地址</dt><dd className="is-wrap">{blank(detail.accessUrl)}</dd></div>
          <div><dt>当前节点</dt><dd>{blank(detail.currentNodeName)}</dd></div>
          {/* Only present while a person still has to act; a finished flow has nothing to assign. */}
          {handleScope(detail) && <div><dt>处理方式</dt><dd>{handleScope(detail)}</dd></div>}
          <div className="is-span"><dt>最近审核意见</dt><dd className="is-wrap">{blank(detail.reviewComment)}</dd></div>
          <div><dt>审核人</dt><dd>{blank(detail.reviewerName)}</dd></div>
          <div><dt>最后更新</dt><dd>{blank(detail.updatedAt)}</dd></div>
        </dl>
        {detail.audit && <section className="review-audit" aria-label="代码审计结果">
          <header className="review-audit__head">
            <strong>代码审计结果</strong>
            <span className={`review-audit__verdict verdict-${(detail.audit.decision ?? detail.audit.executionStatus ?? '').toLowerCase().replaceAll(' ', '-')}`}>
              {detail.audit.executionStatus === 'Rejected' ? '审查请求被拒绝'
                : detail.audit.executionStatus === 'Cancelled' ? '审查已取消'
                : detail.audit.verdict === 'Warning' ? '审查警告，待人工复核'
                : detail.audit.verdict === 'Needs Review' ? '需要人工复核'
                : detail.audit.decision === 'Passed' ? '审计通过'
                : detail.audit.decision === 'Rejected' ? '审计不通过'
                : detail.audit.executionStatus === 'Failed' ? '审计服务失败' : '审计已返回'}
            </span>
          </header>
          {detail.audit.summary && <p className="review-audit__summary">{detail.audit.summary}</p>}
          <dl className="review-audit__meta">
            {detail.audit.executionStatus && <div><dt>审查执行</dt><dd>{({ Completed: '执行完成', Succeeded: '执行成功', Failed: '执行失败', Cancelled: '已取消', Rejected: '登记前拒绝' } as Record<string, string>)[detail.audit.executionStatus] ?? detail.audit.executionStatus}</dd></div>}
            {detail.audit.riskLevel && <div><dt>风险等级</dt><dd>{detail.audit.riskLevel}</dd></div>}
            {detail.audit.taskId && <div><dt>审查任务</dt><dd className="is-mono">{detail.audit.taskId}</dd></div>}
            {detail.audit.finishedAt && <div><dt>完成时间</dt><dd>{new Date(detail.audit.finishedAt).toLocaleString('zh-CN')}</dd></div>}
            {detail.audit.repositoryFullName && <div><dt>审查仓库</dt><dd>{detail.audit.repositoryFullName}</dd></div>}
            {detail.audit.reviewerSubject && <div><dt>申请人工号</dt><dd>{detail.audit.reviewerSubject}</dd></div>}
            {detail.audit.errorCode && <div><dt>错误码</dt><dd>{detail.audit.errorCode}</dd></div>}
            {detail.audit.retryable != null && <div><dt>重新发起</dt><dd>{detail.audit.retryable ? '原因排除后可重新发起' : '需修正请求或配置'}</dd></div>}
            {detail.audit.issueCount && <div><dt>问题条数</dt><dd>{detail.audit.issueCount}</dd></div>}
            {detail.audit.commitSha && <div><dt>审计 Commit</dt><dd className="is-mono">{detail.audit.commitSha.slice(0, 10)}</dd></div>}
          </dl>
          {detail.audit.detailUrl
            ? <a className="review-audit__link" href={detail.audit.detailUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={15}/>查看完整审计详情
              </a>
            : <p className="review-audit__missing">审计服务未提供详情页地址</p>}
        </section>}
        {allowedFor(detail)
          ? <label className="review-detail__comment"><span>审核意见</span><textarea aria-label={`${detail.appName}审核意见`} rows={3} value={comments[detail.id] || ''} placeholder="填写审核意见，退回时必填" onChange={(event) => setComments({ ...comments, [detail.id]: event.target.value })}/></label>
          : <p className="review-detail__readonly"><ShieldCheck size={15}/>{detail.status === '审核中' ? '不在当前处理范围，仅可查看详情' : '该任务已处理完毕，仅可查看详情'}</p>}
      </div>
    </Modal>}
  </div>;
}
