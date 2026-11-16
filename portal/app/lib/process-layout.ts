import type { ProcessDefinition, ProcessNode } from "./process-types";

export const nodeSize = (node: ProcessNode) =>
  node.type === "start" || node.type === "end"
    ? { width: 48, height: 48 }
    : node.type === "gateway"
      ? { width: 68, height: 68 }
      : { width: 140, height: 62 };
export const snapPosition = (value: number) =>
  Math.max(20, Math.round(value / 10) * 10);

export function readProcessDefinition(
  json: string,
  name: string,
): ProcessDefinition {
  const parsed = JSON.parse(json) as ProcessDefinition;
  if (!Array.isArray(parsed.nodes))
    throw new Error("流程定义缺少节点，无法打开设计器");
  return {
    ...parsed,
    name,
    nodes: parsed.nodes.map((node, index) => ({
      ...node,
      x: Number.isFinite(node.x) ? node.x : 60 + index * 200,
      y: Number.isFinite(node.y) ? node.y : 180,
    })),
    // Older definitions were stored in execution order, without visual edges.
    edges: Array.isArray(parsed.edges)
      ? parsed.edges
      : parsed.nodes.slice(1).map((node, index) => ({
          id: `legacy-${index}`,
          source: parsed.nodes[index].id,
          target: node.id,
        })),
  };
}

export function edgePath(source: ProcessNode, target: ProcessNode) {
  const a = nodeSize(source);
  const b = nodeSize(target);
  const forward = target.x >= source.x + a.width;
  const start = { x: source.x + a.width, y: source.y + a.height / 2 };
  const end = { x: target.x, y: target.y + b.height / 2 };
  const bend = Math.max(50, Math.abs(end.x - start.x) / 2);
  return {
    path: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${end.x - bend} ${end.y}, ${end.x} ${end.y}`,
    labelX: (start.x + end.x) / 2,
    labelY: (start.y + end.y) / 2 - (forward ? 10 : 18),
  };
}
