import type { ProcessDefinition } from "./process-types";

export type ProcessHistory = {
  past: ProcessDefinition[];
  present: ProcessDefinition;
  future: ProcessDefinition[];
};
export type ProcessHistoryAction =
  | { type: "commit"; definition: ProcessDefinition }
  | { type: "reset"; definition: ProcessDefinition }
  | { type: "undo" }
  | { type: "redo" };

export function createProcessHistory(
  initial: ProcessDefinition,
): ProcessHistory {
  return { past: [], present: initial, future: [] };
}

export function addProcessEdge(
  definition: ProcessDefinition,
  source: string,
  target: string,
): ProcessDefinition {
  if (
    definition.nodes.find((node) => node.id === source)?.type === "end" ||
    definition.nodes.find((node) => node.id === target)?.type === "start"
  )
    return definition;
  if (
    source === target ||
    !definition.nodes.some((node) => node.id === source) ||
    !definition.nodes.some((node) => node.id === target) ||
    definition.edges.some(
      (edge) => edge.source === source && edge.target === target,
    )
  )
    return definition;
  return {
    ...definition,
    edges: [
      ...definition.edges,
      { id: `edge-${source}-${target}-${Date.now()}`, source, target },
    ],
  };
}

export function removeProcessEdge(
  definition: ProcessDefinition,
  id: string,
): ProcessDefinition {
  return {
    ...definition,
    edges: definition.edges.filter((edge) => edge.id !== id),
  };
}

export function processHistoryReducer(
  state: ProcessHistory,
  action: ProcessHistoryAction,
): ProcessHistory {
  if (action.type === "reset") return createProcessHistory(action.definition);
  if (action.type === "commit")
    return {
      past: [...state.past, state.present],
      present: action.definition,
      future: [],
    };
  if (action.type === "undo" && state.past.length)
    return {
      past: state.past.slice(0, -1),
      present: state.past[state.past.length - 1],
      future: [state.present, ...state.future],
    };
  if (action.type === "redo" && state.future.length)
    return {
      past: [...state.past, state.present],
      present: state.future[0],
      future: state.future.slice(1),
    };
  return state;
}

export function validateProcess(definition: ProcessDefinition): string[] {
  const errors: string[] = [];
  if (!definition.nodes.some((node) => node.type === "start"))
    errors.push("流程缺少开始事件");
  if (!definition.nodes.some((node) => node.type === "end"))
    errors.push("流程缺少结束事件");
  if (definition.nodes.some((node) => !node.name.trim()))
    errors.push("存在未命名节点");
  if (!definition.name.trim()) errors.push("流程名称不能为空");
  if (definition.nodes.filter((node) => node.type === "start").length > 1)
    errors.push("流程只能有一个开始事件");
  if (
    new Set(definition.nodes.map((node) => node.id)).size !==
    definition.nodes.length
  )
    errors.push("节点 ID 不能重复");
  const types = new Map(definition.nodes.map((node) => [node.id, node.type]));
  if (
    definition.edges.some(
      (edge) =>
        !types.has(edge.source) ||
        !types.has(edge.target) ||
        edge.source === edge.target ||
        types.get(edge.source) === "end" ||
        types.get(edge.target) === "start",
    )
  )
    errors.push("流程包含无效连线");
  const reached = new Set(
    definition.nodes
      .filter((node) => node.type === "start")
      .map((node) => node.id),
  );
  while (
    definition.edges.some(
      (edge) => reached.has(edge.source) && !reached.has(edge.target),
    )
  ) {
    for (const edge of definition.edges)
      if (reached.has(edge.source)) reached.add(edge.target);
  }
  if (definition.nodes.some((node) => !reached.has(node.id)))
    errors.push("存在无法从开始事件到达的节点");
  const finishable = new Set(
    definition.nodes
      .filter((node) => node.type === "end")
      .map((node) => node.id),
  );
  while (
    definition.edges.some(
      (edge) => finishable.has(edge.target) && !finishable.has(edge.source),
    )
  ) {
    for (const edge of definition.edges)
      if (finishable.has(edge.target)) finishable.add(edge.source);
  }
  if (definition.nodes.some((node) => !finishable.has(node.id)))
    errors.push("存在无法到达结束事件的节点");
  return errors;
}
