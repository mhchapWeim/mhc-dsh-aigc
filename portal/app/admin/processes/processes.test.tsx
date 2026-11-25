import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProcessManagementPage from "./page";
import { ProcessDesigner } from "./process-designer";
import type { BackendProcessDefinition } from "../../lib/api-client";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  publish: vi.fn(),
  disable: vi.fn(),
  push: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("../../lib/api-client", () => ({
  getProcessDefinitions: api.list,
  saveProcessDefinition: api.create,
  updateProcessDefinition: api.update,
  publishProcessDefinition: api.publish,
  disableProcessDefinition: api.disable,
  getDesignerOptions: vi
    .fn()
    .mockResolvedValue({
      users: [{ value: "person", label: "测试人员", employeeNo: "wh001" }],
      departments: [],
      roles: [{ value: "workflow-admin", label: "流程管理员" }],
    }),
}));
vi.mock("../../components/delete-confirm", () => ({
  useDeleteConfirm: () => ({
    confirmDelete: vi.fn().mockResolvedValue(true),
    deleteConfirmHolder: null,
  }),
}));

const definition = {
  name: "设备审批",
  nodes: [
    { id: "start", type: "start", name: "开始", x: 50, y: 100 },
    { id: "end", type: "end", name: "结束", x: 400, y: 100 },
  ],
  edges: [],
};
const draft: BackendProcessDefinition = {
  id: "draft",
  key: "equipment",
  name: definition.name,
  version: 3,
  definitionJson: JSON.stringify(definition),
  isPublished: false,
  publishedAt: null,
  updatedAt: "2026-11-09T01:00:00Z",
};
const published = {
  ...draft,
  id: "published",
  version: 2,
  isPublished: true,
  publishedAt: "2026-11-08T01:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([draft, published]);
  api.update.mockResolvedValue({ ...draft, updatedAt: "2026-11-09T02:00:00Z" });
  api.create.mockResolvedValue({ ...draft, id: "new-draft", version: 4 });
  api.publish.mockResolvedValue(undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
});
afterEach(() => vi.unstubAllGlobals());

it("opens a grouped process table first and lists versions separately", async () => {
  const user = userEvent.setup();
  render(<ProcessManagementPage />);
  expect(await screen.findByText("equipment")).toBeInTheDocument();
  expect(screen.queryByTestId("process-node")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "编辑草稿" })).toHaveAttribute(
    "href",
    "/admin/processes/draft",
  );
  await user.click(screen.getByRole("button", { name: "版本管理" }));
  expect(screen.getByText("当前发布")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "查看设计" })).toHaveAttribute(
    "href",
    "/admin/processes/published",
  );
  await user.click(screen.getAllByRole("button", { name: "复制为新版本" })[1]);
  expect(api.create).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "equipment",
      version: 0,
      isPublished: false,
    }),
  );
  expect(api.push).toHaveBeenCalledWith("/admin/processes/new-draft");
});

it("creates an empty named draft before opening the editor", async () => {
  const user = userEvent.setup();
  render(<ProcessManagementPage />);
  await screen.findByText("equipment");
  await user.click(screen.getByRole("button", { name: "新建流程" }));
  await user.type(screen.getByLabelText("流程名称"), "维修审批");
  await user.type(screen.getByLabelText("流程编码"), "repair");
  await user.click(screen.getByRole("button", { name: "创建并设计" }));
  expect(api.create).toHaveBeenCalledWith({
    key: "repair",
    name: "维修审批",
    version: 0,
    definition: { name: "维修审批", nodes: [], edges: [] },
    isPublished: false,
    requestType: "publication",
  });
});

it("connects by clicking a source port and the whole target node, then saves the same draft", async () => {
  const user = userEvent.setup();
  render(<ProcessDesigner versionId="draft" />);
  await screen.findByRole("button", { name: "开始" });
  await user.click(screen.getByRole("button", { name: "从开始开始连线" }));
  await user.click(screen.getByRole("button", { name: "结束" }));
  expect(
    screen.getByRole("button", { name: "连线 开始 到 结束" }),
  ).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() =>
    expect(api.update).toHaveBeenCalledWith(
      "draft",
      expect.objectContaining({
        expectedUpdatedAt: draft.updatedAt,
        definition: expect.objectContaining({
          edges: [expect.objectContaining({ source: "start", target: "end" })],
        }),
      }),
    ),
  );
  expect(api.create).not.toHaveBeenCalled();
});

it("moves with pointer capture, keeps a live edge path, and commits one undoable move", async () => {
  api.list.mockResolvedValue([
    {
      ...draft,
      definitionJson: JSON.stringify({
        ...definition,
        edges: [{ id: "edge", source: "start", target: "end" }],
      }),
    },
  ]);
  render(<ProcessDesigner versionId="draft" />);
  const start = await screen.findByRole("button", { name: "开始" });
  const path = screen.getByRole("button", { name: "连线 开始 到 结束" });
  const before = path.getAttribute("d");
  fireEvent.pointerDown(start, { button: 0, clientX: 100, clientY: 100 });
  const canvas = document.querySelector(".process-canvas")!;
  fireEvent.pointerMove(canvas, { clientX: 150, clientY: 130 });
  expect(path.getAttribute("d")).not.toBe(before);
  fireEvent.pointerUp(canvas, { clientX: 150, clientY: 130 });
  expect(HTMLElement.prototype.setPointerCapture).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "撤销" }));
  expect(path.getAttribute("d")).toBe(before);
  expect(screen.getByRole("button", { name: "撤销" })).toBeDisabled();
});

it("supports keyboard movement and cancels a connection with Escape", async () => {
  const user = userEvent.setup();
  render(<ProcessDesigner versionId="draft" />);
  const start = await screen.findByRole("button", { name: "开始" });
  const before = start.style.transform;
  fireEvent.keyDown(start, { key: "ArrowRight" });
  expect(start.style.transform).not.toBe(before);
  await user.click(screen.getByRole("button", { name: "从开始开始连线" }));
  fireEvent.keyDown(start, { key: "Escape" });
  expect(screen.queryByText("点击目标节点完成连线")).not.toBeInTheDocument();
});

it("opens published versions read-only and offers copying to a new version", async () => {
  const user = userEvent.setup();
  render(<ProcessDesigner versionId="published" />);
  await screen.findByRole("button", { name: "开始" });
  expect(screen.getByRole("button", { name: "添加用户任务" })).toBeDisabled();
  expect(
    screen.queryByRole("button", { name: "从开始开始连线" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "保存草稿" }),
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "复制为新版本" }));
  expect(api.create).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "equipment",
      version: 0,
      isPublished: false,
    }),
  );
});

it("assigns a user task through the searchable directory and toggles inbox notification", async () => {
  const user = userEvent.setup();
  render(<ProcessDesigner versionId="draft" />);
  await screen.findByRole("button", { name: "开始" });
  await user.click(screen.getByRole("button", { name: "添加用户任务" }));
  await user.click(screen.getByRole("button", { name: "选择域用户" }));
  await user.type(
    screen.getByRole("searchbox", { name: "搜索域用户" }),
    "wh001",
  );
  await user.click(screen.getByRole("option", { name: /测试人员 wh001/ }));
  expect(screen.getByText("测试人员 · wh001")).toBeInTheDocument();
  const notification = screen.getByRole("switch", { name: "发送站内信" });
  expect(notification).toHaveAttribute("aria-checked", "true");
  await user.click(notification);
  expect(notification).toHaveAttribute("aria-checked", "false");
});

it("offers application-owner assignment on access flows and saves the fallback role", async () => {
  const user = userEvent.setup();
  api.list.mockResolvedValue([{
    ...draft,
    requestType: "access",
    definitionJson: JSON.stringify({
      name: "访问申请",
      nodes: [
        { id: "start", type: "start", name: "开始", x: 40, y: 80 },
        { id: "review", type: "userTask", name: "访问审核", x: 220, y: 80, assignmentType: "role", assignee: "workflow-admin" },
        { id: "end", type: "end", name: "结束", x: 420, y: 80 },
      ],
      edges: [],
    }),
  }]);
  render(<ProcessDesigner versionId="draft" />);
  await user.click(await screen.findByRole("button", { name: "访问审核" }));
  await user.click(screen.getByRole("combobox", { name: "分配方式" }));
  expect(screen.getByRole("option", { name: "应用负责人（缺省转平台审核员）" })).toBeInTheDocument();
  await user.click(screen.getByRole("option", { name: "应用负责人（缺省转平台审核员）" }));
  expect(screen.getByRole("combobox", { name: "兜底审核角色" })).toHaveTextContent("流程管理员");
  await user.click(screen.getByRole("button", { name: "保存草稿" }));
  await waitFor(() => expect(api.update).toHaveBeenCalled());
  const saved = api.update.mock.calls.at(-1)![1].definition.nodes.find((node: { id: string }) => node.id === "review");
  expect(saved.assignmentType).toBe("appOwner");
  expect(saved.fallbackRole).toBe("workflow-admin");
});

it("hides application-owner assignment on publication flows", async () => {
  const user = userEvent.setup();
  render(<ProcessDesigner versionId="draft" />);
  await screen.findByRole("button", { name: "开始" });
  await user.click(screen.getByRole("button", { name: "添加用户任务" }));
  await user.click(screen.getByRole("combobox", { name: "分配方式" }));
  expect(screen.queryByRole("option", { name: "应用负责人（缺省转平台审核员）" })).not.toBeInTheDocument();
});
