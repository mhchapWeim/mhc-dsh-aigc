import type { ProcessDefinition } from './process-types';

export type ProcessHistory = { past: ProcessDefinition[]; present: ProcessDefinition; future: ProcessDefinition[] };
export type ProcessHistoryAction = { type: 'commit'; definition: ProcessDefinition } | { type: 'reset'; definition: ProcessDefinition } | { type: 'undo' } | { type: 'redo' };

export function createProcessHistory(initial: ProcessDefinition): ProcessHistory { return { past: [], present: initial, future: [] }; }

export function addProcessEdge(definition: ProcessDefinition, source: string, target: string): ProcessDefinition {
  if (source === target || !definition.nodes.some((node) => node.id === source) || !definition.nodes.some((node) => node.id === target) || definition.edges.some((edge) => edge.source === source && edge.target === target)) return definition;
  return { ...definition, edges: [...definition.edges, { id: `edge-${source}-${target}-${Date.now()}`, source, target }] };
}

export function removeProcessEdge(definition: ProcessDefinition, id: string): ProcessDefinition { return { ...definition, edges: definition.edges.filter((edge) => edge.id !== id) }; }

export function processHistoryReducer(state: ProcessHistory, action: ProcessHistoryAction): ProcessHistory {
  if (action.type === 'reset') return createProcessHistory(action.definition);
  if (action.type === 'commit') return { past: [...state.past, state.present], present: action.definition, future: [] };
  if (action.type === 'undo' && state.past.length) return { past: state.past.slice(0, -1), present: state.past[state.past.length - 1], future: [state.present, ...state.future] };
  if (action.type === 'redo' && state.future.length) return { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) };
  return state;
}

export function validateProcess(definition: ProcessDefinition): string[] {
  const errors: string[] = [];
  if (!definition.nodes.some((node) => node.type === 'start')) errors.push('流程缺少开始事件');
  if (!definition.nodes.some((node) => node.type === 'end')) errors.push('流程缺少结束事件');
  if (definition.nodes.some((node) => !node.name.trim())) errors.push('存在未命名节点');
  return errors;
}
