export type ProcessNodeType = 'start' | 'end' | 'userTask' | 'serviceTask' | 'gateway';
export type AssignmentType = 'users' | 'department' | 'role' | 'initiator';
export type ProcessNode = { id: string; type: ProcessNodeType; name: string; x: number; y: number; assignee?: string; assignmentType?: AssignmentType; assigneeIds?: string[]; notifyInbox?: boolean; description?: string; condition?: string };
export type ProcessEdge = { id: string; source: string; target: string; label?: string };
export type ProcessDefinition = { name: string; nodes: ProcessNode[]; edges: ProcessEdge[] };

export const sampleProcess: ProcessDefinition = {
  name: '内容审核发布流程',
  nodes: [
    { id: 'start', type: 'start', name: '开始', x: 50, y: 210 },
    { id: 'generate', type: 'serviceTask', name: '生成内容', x: 170, y: 190, assignee: '内容生成 Agent' },
    { id: 'review', type: 'userTask', name: '人工审核', x: 350, y: 190, assignee: '内容运营组', assignmentType: 'department', notifyInbox: true },
    { id: 'gateway', type: 'gateway', name: '审核通过？', x: 545, y: 205, condition: '审核结果 == 通过' },
    { id: 'publish', type: 'serviceTask', name: '发布内容', x: 680, y: 125, assignee: '发布服务' },
    { id: 'revise', type: 'userTask', name: '修改内容', x: 680, y: 285, assignee: '内容运营组', assignmentType: 'department', notifyInbox: true },
    { id: 'end', type: 'end', name: '结束', x: 870, y: 145 },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'generate' }, { id: 'e2', source: 'generate', target: 'review' }, { id: 'e3', source: 'review', target: 'gateway' },
    { id: 'e4', source: 'gateway', target: 'publish', label: '通过' }, { id: 'e5', source: 'gateway', target: 'revise', label: '退回' }, { id: 'e6', source: 'publish', target: 'end' },
    { id: 'e7', source: 'revise', target: 'review' },
  ],
};
