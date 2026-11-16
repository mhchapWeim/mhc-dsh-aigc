import type { ProcessDefinition } from './process-types';

export function integratedPublicationTemplate(name: string): ProcessDefinition {
  return {
    name, executionMode: 'integrated-v1',
    nodes: [
      { id: 'start', type: 'start', name: '开始', x: 40, y: 140 },
      { id: 'code_audit', type: 'serviceTask', name: '代码审计', x: 160, y: 130, serviceCode: 'code-audit', operationCode: 'review.requested', timeoutSeconds: 86400, verifyCommit: true },
      { id: 'audit_manual_review', type: 'userTask', name: '审计人工复核', x: 160, y: 330, assignmentType: 'role', assignee: 'workflow-admin' },
      { id: 'deploy_review', type: 'userTask', name: '部署审批', x: 370, y: 130, assignmentType: 'role', assignee: 'workflow-admin' },
      { id: 'deploy', type: 'serviceTask', name: '部署应用', x: 580, y: 130, serviceCode: 'deployment', operationCode: 'deploy.submit.v1', timeoutSeconds: 86400, verifyCommit: true, deploymentUrlField: 'deploymentUrl' },
      { id: 'published', type: 'end', name: '发布完成', x: 820, y: 140, result: 'Approved' },
      { id: 'rejected', type: 'end', name: '退回申请', x: 370, y: 330, result: 'Rejected' },
      { id: 'failed', type: 'end', name: '服务异常', x: 600, y: 330, result: 'Failed' },
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'code_audit' },
      { id: 'e2', source: 'code_audit', target: 'deploy_review', outcome: 'passed', label: '审计通过' },
      { id: 'e3', source: 'code_audit', target: 'rejected', outcome: 'rejected', label: '审计拒绝' },
      { id: 'e9', source: 'code_audit', target: 'audit_manual_review', outcome: 'needs-review', label: '警告或需复核' },
      { id: 'e10', source: 'audit_manual_review', target: 'deploy_review', outcome: 'passed', label: '复核通过' },
      { id: 'e11', source: 'audit_manual_review', target: 'rejected', label: '复核退回' },
      { id: 'e4', source: 'code_audit', target: 'failed', label: '异常或超时' },
      { id: 'e5', source: 'deploy_review', target: 'deploy', outcome: 'passed', label: '批准部署' },
      { id: 'e6', source: 'deploy_review', target: 'rejected', label: '退回' },
      { id: 'e7', source: 'deploy', target: 'published', outcome: 'succeeded', label: '部署成功' },
      { id: 'e8', source: 'deploy', target: 'failed', label: '异常或超时' },
    ],
  };
}
