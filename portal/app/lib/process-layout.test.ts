import {
  edgePath,
  readProcessDefinition,
  snapPosition,
} from "./process-layout";
import type { ProcessNode } from "./process-types";

it("opens legacy definitions in order while preserving execution fields", () => {
  const parsed = readProcessDefinition(
    JSON.stringify({
      nodes: [
        { id: "start", type: "start", name: "开始" },
        {
          id: "review",
          type: "userTask",
          name: "审核",
          candidates: ["role:admin"],
        },
        { id: "end", type: "end", name: "结束" },
      ],
    }),
    "旧流程",
  );
  expect(parsed.name).toBe("旧流程");
  expect(parsed.nodes[1].candidates).toEqual(["role:admin"]);
  expect(parsed.nodes[1].x).toBe(260);
  expect(parsed.edges.map((edge) => [edge.source, edge.target])).toEqual([
    ["start", "review"],
    ["review", "end"],
  ]);
});

it("preserves intentionally empty edge arrays and existing node positions", () => {
  const parsed = readProcessDefinition(
    JSON.stringify({
      nodes: [{ id: "review", type: "userTask", name: "审核", x: 450, y: 200 }],
      edges: [],
    }),
    "草稿",
  );
  expect(parsed.edges).toEqual([]);
  expect(parsed.nodes[0].x).toBe(450);
});

it("routes from node boundaries and follows updated coordinates", () => {
  const source: ProcessNode = {
    id: "a",
    type: "userTask",
    name: "A",
    x: 100,
    y: 100,
  };
  const target: ProcessNode = {
    id: "b",
    type: "end",
    name: "B",
    x: 500,
    y: 100,
  };
  expect(edgePath(source, target).path).toMatch(/^M 240 131/);
  expect(edgePath({ ...source, x: 200 }, target).path).toMatch(/^M 340 131/);
  expect(edgePath(source, target).path).toMatch(/500 124$/);
  expect(snapPosition(-50)).toBe(20);
  expect(snapPosition(137)).toBe(140);
});
