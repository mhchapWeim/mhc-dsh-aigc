import type { PortalApp } from './types';

type DemoPortalApp = Omit<PortalApp, 'accessUrl' | 'publishedAt' | 'status'> & { visits: number; status: '运行中' | '维护中' };

export const portalApps: DemoPortalApp[] = [
  { id: 'hui-assistant', name: '湾惠助手智能体', description: '公司人事制度一站式查询，覆盖考勤、加班、绩效、请假与差旅场景。', category: '智慧服务', tags: ['人事服务', '制度问答'], owner: '人力资源部', visits: 196, status: '运行中', accent: '#2366d1' },
  { id: 'quality-knowledge', name: '质量知识助手', description: '快速检索质量标准、问题案例与处置经验，辅助现场质量决策。', category: '知识智能', tags: ['质量管理', '知识库'], owner: '质量管理部', visits: 328, status: '运行中', accent: '#7357d9' },
  { id: 'employee-partner', name: '员工职伴智能体', description: '面向员工的职业伙伴，提供入离职、招聘、培训与考勤咨询。', category: '智慧服务', tags: ['员工服务', '7×24'], owner: '人力资源部', visits: 83, status: '运行中', accent: '#0f8f91' },
  { id: 'meeting-copilot', name: '会议纪要 Copilot', description: '整理会议要点、行动项与责任人，让协作任务清晰可追踪。', category: '效率办公', tags: ['会议纪要', '协同'], owner: '数字化办公室', visits: 271, status: '运行中', accent: '#d56b1c' },
  { id: 'contract-review', name: '合同审阅助手', description: '识别合同风险条款并提供审阅建议，缩短内部法务沟通周期。', category: '知识智能', tags: ['法务', '风险识别'], owner: '法务部', visits: 142, status: '维护中', accent: '#aa4b74' },
  { id: 'code-companion', name: '研发代码伙伴', description: '面向内部研发团队的代码问答、规范检查与方案辅助工具。', category: '研发创新', tags: ['研发', '代码助手'], owner: '研发中心', visits: 418, status: '运行中', accent: '#375c9b' },
];
