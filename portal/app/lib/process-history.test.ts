import { describe, expect, it } from "vitest";
import {
  addProcessEdge,
  createProcessHistory,
  processHistoryReducer,
  removeProcessEdge,
  validateProcess,
} from "./process-history";
import type { ProcessDefinition } from "./process-types";

const definition: ProcessDefinition = {
  name: "测试流程",
  nodes: [
    { id: "start", type: "start", name: "开始", x: 20, y: 40 },
    { id: "end", type: "end", name: "结束", x: 300, y: 40 },
  ],
  edges: [{ id: "edge-1", source: "start", target: "end" }],
};

describe("process history", () => {
  it("undoes and redoes a committed process change", () => {
    const initial = createProcessHistory(definition);
    const changed = { ...definition, name: "修改后的流程" };
    const committed = processHistoryReducer(initial, {
      type: "commit",
      definition: changed,
    });
    const undone = processHistoryReducer(committed, { type: "undo" });
    const redone = processHistoryReducer(undone, { type: "redo" });

    expect(undone.present.name).toBe("测试流程");
    expect(redone.present.name).toBe("修改后的流程");
  });

  it("reports missing end events and unnamed nodes", () => {
    const errors = validateProcess({
      ...definition,
      nodes: [{ ...definition.nodes[0], name: "" }],
    });

    expect(errors).toContain("流程缺少结束事件");
    expect(errors).toContain("存在未命名节点");
  });

  it("creates a unique connection and rejects self or duplicate connections", () => {
    const unconnected = { ...definition, edges: [] };
    const first = addProcessEdge(unconnected, "start", "end");
    expect(first.edges).toHaveLength(1);
    expect(addProcessEdge(first, "start", "end").edges).toHaveLength(1);
    expect(addProcessEdge(first, "end", "start")).toBe(first);
    expect(addProcessEdge(first, "start", "start")).toBe(first);
  });

  it("removes a selected connection", () => {
    expect(removeProcessEdge(definition, "edge-1").edges).toHaveLength(0);
  });

  it("rejects disconnected nodes and paths with no way to end", () => {
    expect(validateProcess(definition)).toEqual([]);
    expect(validateProcess({ ...definition, edges: [] })).toContain(
      "存在无法从开始事件到达的节点",
    );
    expect(
      validateProcess({
        ...definition,
        nodes: [
          ...definition.nodes,
          {
            id: "orphan",
            name: "无出口任务",
            type: "userTask",
            x: 100,
            y: 100,
          },
        ],
        edges: [
          ...definition.edges,
          { id: "dead-end", source: "start", target: "orphan" },
        ],
      }),
    ).toContain("存在无法到达结束事件的节点");
  });
});
