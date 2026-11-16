"use client";
import { IntegrationNodeProperties } from "./integration-node-properties";

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  CheckCircle2,
  Circle,
  Copy,
  Diamond,
  Focus,
  Hand,
  MousePointer2,
  Redo2,
  Save,
  Send,
  SlidersHorizontal,
  Trash2,
  Undo2,
  UserRound,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useDeleteConfirm } from "../../components/delete-confirm";
import { Modal } from "../../components/modal";
import { DirectoryUserPicker } from "../../components/directory-user-picker";
import { ModernSelect } from "../../components/modern-select";
import {
  getDesignerOptions,
  getProcessDefinitions,
  updateProcessDefinition,
  publishProcessDefinition,
  saveProcessDefinition,
  type BackendProcessDefinition,
  type DesignerOption,
} from "../../lib/api-client";
import {
  addProcessEdge,
  createProcessHistory,
  processHistoryReducer,
  removeProcessEdge,
  validateProcess,
} from "../../lib/process-history";
import {
  edgePath,
  nodeSize,
  readProcessDefinition,
  snapPosition,
} from "../../lib/process-layout";
import type {
  AssignmentType,
  ProcessDefinition,
  ProcessNode,
  ProcessNodeType,
} from "../../lib/process-types";

const palette = [
  { type: "start", label: "开始事件", icon: Circle },
  { type: "end", label: "结束事件", icon: Circle },
  { type: "userTask", label: "用户任务", icon: UserRound },
  { type: "serviceTask", label: "服务任务", icon: Bot },
  { type: "gateway", label: "排他网关", icon: Diamond },
] as const;
const fallbackDirectoryUsers: Array<{
  id: string;
  name: string;
  employeeNo: string;
  department: string;
  email: string;
  role: string;
  status: "启用";
  lastLogin: string;
}> = [];
const assignmentOptions = [
  { value: "users", label: "指定域用户" },
  { value: "department", label: "按部门分配" },
  { value: "role", label: "按平台角色" },
  { value: "initiator", label: "流程发起人" },
];
const emptyDefinition: ProcessDefinition = { name: "", nodes: [], edges: [] };
type Point = { x: number; y: number };
type Gesture =
  | {
      kind: "node";
      id: string;
      start: Point;
      base: Point;
      delta: Point;
      moved: boolean;
      pointerId: number;
    }
  | { kind: "pan"; start: Point; scroll: Point; pointerId: number }
  | { kind: "connect"; start: Point; moved: boolean; pointerId: number };

export function ProcessDesigner({ versionId }: { versionId: string }) {
  const router = useRouter();
  const { confirmDelete, deleteConfirmHolder } = useDeleteConfirm();
  const [history, dispatch] = useReducer(
    processHistoryReducer,
    emptyDefinition,
    createProcessHistory,
  );
  const definition = history.present;
  const [record, setRecord] = useState<BackendProcessDefinition | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [selectedEdgeId, setSelectedEdgeId] = useState("");
  const [scale, setScale] = useState(1);
  const [mode, setMode] = useState<"select" | "pan">("select");
  const [dragPosition, setDragPosition] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [pointer, setPointer] = useState<Point | null>(null);
  const [validation, setValidation] = useState<string[] | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [directoryUsers, setDirectoryUsers] = useState(fallbackDirectoryUsers);
  const [departmentOptions, setDepartmentOptions] = useState<DesignerOption[]>(
    [],
  );
  const [roleOptions, setRoleOptions] = useState<DesignerOption[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const readOnly = Boolean(record?.isPublished || record?.publishedAt);
  const editable = !readOnly && !busy;
  const dirty = Boolean(record) && JSON.stringify(definition) !== savedJson;
  const selected =
    definition.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedEdge = definition.edges.find(
    (edge) => edge.id === selectedEdgeId,
  );
  const liveNodes = useMemo(
    () =>
      definition.nodes.map((node) =>
        dragPosition?.id === node.id
          ? { ...node, x: dragPosition.x, y: dragPosition.y }
          : node,
      ),
    [definition.nodes, dragPosition],
  );
  const nodesById = useMemo(
    () => new Map(liveNodes.map((node) => [node.id, node])),
    [liveNodes],
  );
  const width = Math.max(
    1200,
    ...liveNodes.map((node) => node.x + nodeSize(node).width + 240),
  );
  const height = Math.max(
    800,
    ...liveNodes.map((node) => node.y + nodeSize(node).height + 200),
  );

  const fit = (nodes = definition.nodes) => {
    const canvas = canvasRef.current;
    if (!canvas || !nodes.length) {
      setScale(1);
      canvas?.scrollTo(0, 0);
      return;
    }
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + nodeSize(n).width));
    const maxY = Math.max(...nodes.map((n) => n.y + nodeSize(n).height + 30));
    const next = Math.max(
      0.25,
      Math.min(
        1.25,
        (canvas.clientWidth - 80) / (maxX - minX + 80),
        (canvas.clientHeight - 140) / (maxY - minY + 80),
      ),
    );
    setScale(next);
    requestAnimationFrame(() =>
      canvas.scrollTo(
        Math.max(0, minX * next - 40),
        Math.max(0, minY * next - 60),
      ),
    );
  };
  useEffect(() => {
    let active = true;
    getProcessDefinitions()
      .then((items) => {
        if (!active) return;
        const item = items.find((item) => item.id === versionId);
        if (!item) throw new Error("流程版本不存在");
        const parsed = readProcessDefinition(item.definitionJson, item.name);
        setRecord(item);
        dispatch({ type: "reset", definition: parsed });
        setSavedJson(JSON.stringify(parsed));
        setError("");
        setLoading(false);
        setMessage(
          item.isPublished || item.publishedAt
            ? "已发布版本只读，修改请复制为新版本"
            : "草稿已加载",
        );
        requestAnimationFrame(() => fit(parsed.nodes));
      })
      .catch((e) => {
        if (active) {
          setError(e instanceof Error ? e.message : "加载失败");
          setLoading(false);
        }
      });
    getDesignerOptions()
      .then((options) => {
        if (!active) return;
        setDirectoryUsers(
          options.users.map((user) => ({
            id: user.value,
            name: user.label,
            employeeNo: user.employeeNo ?? "",
            department: "企业目录",
            email: "",
            role: "",
            status: "启用",
            lastLogin: "",
          })),
        );
        setDepartmentOptions(options.departments);
        setRoleOptions(options.roles);
      })
      .catch((e) => {
        if (active)
          setMessage(
            `人员目录加载失败：${e instanceof Error ? e.message : "请重试"}`,
          );
      });
    return () => {
      active = false;
    };
    // Fit once after loading, then preserve the user's viewport while editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, loadAttempt]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const commit = (next: ProcessDefinition) => {
    if (!editable) return;
    dispatch({ type: "commit", definition: next });
    setMessage("");
  };
  const updateSelected = (patch: Partial<ProcessNode>) =>
    selected &&
    commit({
      ...definition,
      nodes: definition.nodes.map((node) =>
        node.id === selected.id ? { ...node, ...patch } : node,
      ),
    });
  const connectTo = (target: string) => {
    if (!connectingFrom || !editable) return;
    const next = addProcessEdge(definition, connectingFrom, target);
    if (next === definition) {
      setMessage("不能连接自身、重复连线、从结束事件连出或连入开始事件");
      return;
    }
    commit(next);
    setSelectedEdgeId(next.edges.at(-1)!.id);
    setSelectedId("");
    setConnectingFrom(null);
    setPointer(null);
    setMessage("连线已创建，可在右侧编辑连线名称");
  };
  const addNode = (type: ProcessNodeType, position?: Point) => {
    if (!editable) return;
    const canvas = canvasRef.current;
    const x =
      position?.x ??
      ((canvas?.scrollLeft ?? 0) + (canvas?.clientWidth ?? 600) / 2) / scale -
        70;
    const y =
      position?.y ??
      ((canvas?.scrollTop ?? 0) + (canvas?.clientHeight ?? 400) / 2) / scale -
        30;
    const offset =
      definition.nodes.filter(
        (node) =>
          Math.abs(node.x - snapPosition(x)) < 25 &&
          Math.abs(node.y - snapPosition(y)) < 25,
      ).length * 40;
    const node: ProcessNode = {
      id: `node-${crypto.randomUUID()}`,
      type,
      name: palette.find((item) => item.type === type)!.label,
      x: snapPosition(x + offset),
      y: snapPosition(y + offset),
      ...(type === "userTask"
        ? {
            assignmentType: "users" as AssignmentType,
            assigneeIds: [],
            notifyInbox: true,
          }
        : {}),
    };
    commit({ ...definition, nodes: [...definition.nodes, node] });
    setSelectedId(node.id);
    setSelectedEdgeId("");
  };
  const deleteSelected = async () => {
    if (
      !editable ||
      !selected ||
      !(await confirmDelete("删除当前流程节点及其连线？"))
    )
      return;
    commit({
      ...definition,
      nodes: definition.nodes.filter((n) => n.id !== selected.id),
      edges: definition.edges.filter(
        (e) => e.source !== selected.id && e.target !== selected.id,
      ),
    });
    setSelectedId("");
  };
  const pointAt = (clientX: number, clientY: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  };
  const capture = (event: React.PointerEvent) =>
    canvasRef.current?.setPointerCapture(event.pointerId);
  const movePointer = (event: React.PointerEvent) => {
    if (connectingFrom && stageRef.current)
      setPointer(pointAt(event.clientX, event.clientY));
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.start.x;
    const dy = event.clientY - current.start.y;
    if (current.kind === "pan") {
      canvasRef.current!.scrollLeft = current.scroll.x - dx;
      canvasRef.current!.scrollTop = current.scroll.y - dy;
    }
    if (current.kind === "connect") current.moved ||= Math.hypot(dx, dy) > 4;
    if (current.kind === "node") {
      current.moved ||= Math.hypot(dx, dy) > 4;
      current.delta = { x: dx / scale, y: dy / scale };
      if (current.moved)
        setDragPosition({
          id: current.id,
          x: snapPosition(current.base.x + current.delta.x),
          y: snapPosition(current.base.y + current.delta.y),
        });
    }
  };
  const finishPointer = (event: React.PointerEvent, cancelled = false) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (canvasRef.current?.hasPointerCapture(event.pointerId))
      canvasRef.current.releasePointerCapture(event.pointerId);
    if (current.kind === "node" && current.moved && !cancelled) {
      const dx = (event.clientX - current.start.x) / scale;
      const dy = (event.clientY - current.start.y) / scale;
      commit({
        ...definition,
        nodes: definition.nodes.map((node) =>
          node.id === current.id
            ? {
                ...node,
                x: snapPosition(current.base.x + dx),
                y: snapPosition(current.base.y + dy),
              }
            : node,
        ),
      });
    }
    if (current.kind === "connect" && current.moved) {
      if (!cancelled) {
        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
        if (target) connectTo(target);
        else setMessage("未连接：请点击目标节点，或按 Esc 取消");
      } else {
        setConnectingFrom(null);
        setPointer(null);
      }
    }
    if (current.kind !== "pan" && current.moved) {
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
    }
    setDragPosition(null);
  };
  const zoom = useCallback(
    (next: number, client?: Point) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bounded = Math.max(0.25, Math.min(2, next));
      const rect = canvas.getBoundingClientRect();
      const x = client ? client.x - rect.left : canvas.clientWidth / 2;
      const y = client ? client.y - rect.top : canvas.clientHeight / 2;
      const left = ((canvas.scrollLeft + x) * bounded) / scale - x;
      const top = ((canvas.scrollTop + y) * bounded) / scale - y;
      setScale(bounded);
      requestAnimationFrame(() => canvas.scrollTo(left, top));
    },
    [scale],
  );
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoom(scale * (event.deltaY > 0 ? 0.9 : 1.1), {
        x: event.clientX,
        y: event.clientY,
      });
    };
    canvas.addEventListener("wheel", wheel, { passive: false });
    return () => canvas.removeEventListener("wheel", wheel);
  }, [zoom, scale, loading]);
  const persist = async (publish: boolean) => {
    if (!record || busy || readOnly) return;
    setBusy(true);
    setError("");
    try {
      const saved = await updateProcessDefinition(record.id, {
        name: definition.name,
        definition,
        expectedUpdatedAt: record.updatedAt,
      });
      setRecord(saved);
      setSavedJson(JSON.stringify(definition));
      if (publish) {
        await publishProcessDefinition(saved.id, saved.updatedAt);
        const refreshed = (await getProcessDefinitions()).find(
          (item) => item.id === saved.id,
        );
        if (refreshed) setRecord(refreshed);
        setPublishOpen(false);
      }
      setMessage(
        publish ? `V${saved.version} 已发布` : `草稿 V${saved.version} 已保存`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };
  const copyVersion = async () => {
    if (!record || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await saveProcessDefinition({
        key: record.key,
        name: definition.name,
        version: 0,
        definition,
        isPublished: false,
      });
      router.push(`/admin/processes/${next.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };
  const runValidation = () => {
    const errors = validateProcess(definition);
    setValidation(errors);
    setMessage(errors.length ? "请修复校验问题" : "流程校验通过");
    return errors;
  };
  const leave = () => {
    if (!dirty || window.confirm("当前草稿有未保存的更改，确定离开？"))
      router.push("/admin/processes");
  };
  if (loading)
    return (
      <div className="empty-state" role="status">
        正在加载流程版本…
      </div>
    );
  if (!record)
    return (
      <div className="admin-page">
        <div className="model-form-error" role="alert">
          {error}
        </div>
        <button
          className="secondary-action"
          type="button"
          onClick={() => {
            setLoading(true);
            setLoadAttempt((value) => value + 1);
          }}
        >
          重新加载
        </button>
        <button className="secondary-action" type="button" onClick={leave}>
          返回流程列表
        </button>
      </div>
    );
  return (
    <div
      className={`process-page process-editor page-enter${mode === "pan" ? " is-pan-mode" : ""}${connectingFrom ? " is-linking" : ""}${propertiesOpen ? " is-properties-open" : ""}`}
      onKeyDown={(event) => {
        const target = event.target as HTMLElement;
        if (event.key === "Escape") {
          setConnectingFrom(null);
          setPointer(null);
          gesture.current = null;
          setDragPosition(null);
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          if (editable) void persist(false);
          return;
        }
        if (target.closest('input, textarea, select, [contenteditable="true"]'))
          return;
        if (editable && (event.key === 'Delete' || event.key === 'Backspace')) {
          event.preventDefault();
          if (selectedEdge) {
            commit(removeProcessEdge(definition, selectedEdge.id));
            setSelectedEdgeId('');
          } else if (selected) void deleteSelected();
        }
        if (
          editable &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          dispatch({ type: event.shiftKey ? "redo" : "undo" });
        }
      }}
    >
      {deleteConfirmHolder}
      <div className="process-toolbar">
        <div className="process-title">
          <button
            type="button"
            className="secondary-action"
            aria-label="返回流程列表"
            onClick={leave}
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1>
              {record.name}{" "}
              <small>
                V{record.version} ·{" "}
                {readOnly
                  ? record.isPublished
                    ? "当前发布 · 只读"
                    : "历史版本 · 只读"
                  : "草稿"}
              </small>
            </h1>
            <span role="status">{dirty ? "存在未保存的更改" : message || "所有更改已保存"}</span>
          </div>
        </div>
        <div className="process-toolbar__actions">
          <button
            type="button"
            className="properties-toggle"
            aria-label="切换属性面板"
            aria-pressed={propertiesOpen}
            onClick={() => setPropertiesOpen((value) => !value)}
          >
            <SlidersHorizontal size={17} />
            属性
          </button>
          <button
            type="button"
            aria-label="撤销"
            title="撤销 Ctrl+Z"
            disabled={!editable || !history.past.length}
            onClick={() => dispatch({ type: "undo" })}
          >
            <Undo2 size={17} />
          </button>
          <button
            type="button"
            aria-label="重做"
            title="重做 Ctrl+Shift+Z"
            disabled={!editable || !history.future.length}
            onClick={() => dispatch({ type: "redo" })}
          >
            <Redo2 size={17} />
          </button>
          <button type="button" onClick={() => runValidation()}>
            <CheckCircle2 size={17} />
            校验
          </button>
          {readOnly ? (
            <button
              type="button"
              className="primary-action"
              disabled={busy}
              onClick={() => void copyVersion()}
            >
              <Copy size={17} />
              复制为新版本
            </button>
          ) : (
            <>
              <button
                type="button"
                disabled={busy || !dirty}
                onClick={() => void persist(false)}
              >
                <Save size={17} />
                {busy ? "处理中…" : "保存草稿"}
              </button>
              <button
                type="button"
                className="primary-action"
                disabled={busy}
                onClick={() => {
                  if (!runValidation().length) setPublishOpen(true);
                }}
              >
                <Send size={17} />
                发布版本
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <div className="model-form-error process-editor-error" role="alert">
          {error}
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="designer-shell">
        <aside className="node-palette">
          <div className="designer-pane-title">
            <span>流程元素</span>
            <small>{readOnly ? "只读预览" : "拖入画布，或点击添加"}</small>
          </div>
          <div className="palette-section">
            {palette.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                type="button"
                disabled={!editable}
                aria-label={`添加${label}`}
                draggable={editable}
                onDragStart={(event) => {
                  event.dataTransfer.setData(
                    "application/x-process-node",
                    type,
                  );
                  event.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addNode(type)}
              >
                <span className={`palette-icon type-${type}`}>
                  <Icon size={19} />
                </span>
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="palette-tip">
            <MousePointer2 size={18} />
            <span>
              拖动节点移动
              <br />
              右侧圆点连线，点击目标节点完成
              <br />
              空白处用平移工具拖动画布
              <br />
              Esc 取消连线
              <br />
              方向键微调节点
            </span>
          </div>
        </aside>
        <section className="process-canvas-wrap" aria-label="流程画布">
          <div className="canvas-mode-tools">
            <button
              type="button"
              aria-label="选择工具"
              aria-pressed={mode === "select"}
              onClick={() => setMode("select")}
            >
              <MousePointer2 size={17} />
            </button>
            <button
              type="button"
              aria-label="平移工具"
              aria-pressed={mode === "pan"}
              onClick={() => {
                setMode("pan");
                setConnectingFrom(null);
              }}
            >
              <Hand size={17} />
            </button>
          </div>
          {connectingFrom && (
            <div className="connection-hint" role="status">
              点击目标节点完成连线
              <button
                type="button"
                onClick={() => {
                  setConnectingFrom(null);
                  setPointer(null);
                }}
              >
                取消 Esc
              </button>
            </div>
          )}
          <div className="canvas-tools">
            <button
              type="button"
              aria-label="缩小"
              onClick={() => zoom(scale - 0.1)}
            >
              <ZoomOut size={17} />
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              type="button"
              aria-label="放大"
              onClick={() => zoom(scale + 0.1)}
            >
              <ZoomIn size={17} />
            </button>
            <button type="button" aria-label="适应画布" onClick={() => fit()}>
              <Focus size={17} />
            </button>
          </div>
          <div
            className="process-canvas"
            ref={canvasRef}
            onPointerMove={movePointer}
            onPointerUp={(event) => finishPointer(event)}
            onPointerCancel={(event) => finishPointer(event, true)}
            onLostPointerCapture={(event) => {
              if (gesture.current?.pointerId === event.pointerId)
                finishPointer(event, true);
            }}
            onPointerDown={(event) => {
              if (
                event.button === 1 ||
                (mode === "pan" && event.button === 0)
              ) {
                event.preventDefault();
                gesture.current = {
                  kind: "pan",
                  start: { x: event.clientX, y: event.clientY },
                  scroll: {
                    x: event.currentTarget.scrollLeft,
                    y: event.currentTarget.scrollTop,
                  },
                  pointerId: event.pointerId,
                };
                capture(event);
              } else if (
                event.target === event.currentTarget ||
                (event.target as HTMLElement).classList.contains("canvas-stage")
              ) {
                setSelectedId("");
                setSelectedEdgeId("");
              }
            }}
            onDragOver={(event) => {
              if (
                editable &&
                event.dataTransfer.types.includes("application/x-process-node")
              ) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }
            }}
            onDrop={(event) => {
              const type = event.dataTransfer.getData(
                "application/x-process-node",
              ) as ProcessNodeType;
              if (editable && palette.some((item) => item.type === type)) {
                event.preventDefault();
                addNode(type, pointAt(event.clientX, event.clientY));
              }
            }}
          >
            <div
              className="canvas-size"
              style={{ width: width * scale, height: height * scale }}
            >
              <div
                className="canvas-stage"
                ref={stageRef}
                style={{ width, height, transform: `scale(${scale})` }}
              >
                <svg className="process-edges" width={width} height={height}>
                  <defs>
                    <marker
                      id="process-arrow"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" />
                    </marker>
                  </defs>
                  {definition.edges.map((edge) => {
                    const source = nodesById.get(edge.source);
                    const target = nodesById.get(edge.target);
                    if (!source || !target) return null;
                    const line = edgePath(source, target);
                    return (
                      <g
                        key={edge.id}
                        className={
                          edge.id === selectedEdgeId ? "is-selected" : ""
                        }
                      >
                        <path
                          className="edge-hit"
                          d={line.path}
                          role="button"
                          tabIndex={0}
                          aria-label={`连线 ${source.name} 到 ${target.name}`}
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={() => {
                            setSelectedEdgeId(edge.id);
                            setSelectedId("");
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setSelectedEdgeId(edge.id);
                              setSelectedId("");
                            }
                          }}
                        />
                        <path
                          className="edge-line"
                          d={line.path}
                          markerEnd="url(#process-arrow)"
                        />
                        {edge.label && (
                          <text x={line.labelX} y={line.labelY}>
                            {edge.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                  {connectingFrom &&
                    pointer &&
                    nodesById.has(connectingFrom) &&
                    (() => {
                      const source = nodesById.get(connectingFrom)!;
                      const size = nodeSize(source);
                      const x = source.x + size.width;
                      const y = source.y + size.height / 2;
                      return (
                        <path
                          className="edge-preview"
                          d={`M ${x} ${y} C ${x + 60} ${y}, ${pointer.x - 60} ${pointer.y}, ${pointer.x} ${pointer.y}`}
                          markerEnd="url(#process-arrow)"
                        />
                      );
                    })()}
                </svg>
                {!definition.nodes.length && (
                  <div className="canvas-empty">
                    从左侧拖入开始事件，开始设计流程
                  </div>
                )}
                {liveNodes.map((node) => (
                  <div
                    key={node.id}
                    data-testid="process-node"
                    data-node-id={node.id}
                    role="button"
                    tabIndex={0}
                    aria-label={node.name}
                    aria-pressed={node.id === selectedId}
                    className={`process-node type-${node.type}${node.id === selectedId ? " is-selected" : ""}${node.id === connectingFrom ? " is-connecting" : ""}${connectingFrom && node.type !== "start" && node.id !== connectingFrom && !definition.edges.some((edge) => edge.source === connectingFrom && edge.target === node.id) ? " is-connect-target" : ""}${dragPosition?.id === node.id ? " is-dragging" : ""}`}
                    style={{ transform: `translate(${node.x}px,${node.y}px)` }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (suppressClick.current || mode === "pan") return;
                      if (connectingFrom) connectTo(node.id);
                      else {
                        setSelectedId(node.id);
                        setSelectedEdgeId("");
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        if (connectingFrom) connectTo(node.id);
                        else {
                          setSelectedId(node.id);
                          setSelectedEdgeId("");
                        }
                      }
                      if (!editable) return;
                      if (
                        [
                          "ArrowLeft",
                          "ArrowRight",
                          "ArrowUp",
                          "ArrowDown",
                        ].includes(event.key)
                      ) {
                        event.preventDefault();
                          setSelectedId(node.id);
                          setSelectedEdgeId('');
                        const step = event.shiftKey ? 50 : 10;
                        commit({
                          ...definition,
                          nodes: definition.nodes.map((n) =>
                            n.id === node.id
                              ? {
                                  ...n,
                                  x: snapPosition(
                                    n.x +
                                      (event.key === "ArrowRight"
                                        ? step
                                        : event.key === "ArrowLeft"
                                          ? -step
                                          : 0),
                                  ),
                                  y: snapPosition(
                                    n.y +
                                      (event.key === "ArrowDown"
                                        ? step
                                        : event.key === "ArrowUp"
                                          ? -step
                                          : 0),
                                  ),
                                }
                              : n,
                          ),
                        });
                      }
                    }}
                    onPointerDown={(event) => {
                      if (
                        mode === "pan" ||
                        event.button !== 0 ||
                        !editable ||
                        connectingFrom ||
                        (event.target as HTMLElement).closest(".node-port")
                      )
                        return;
                      event.stopPropagation();
                      event.preventDefault();
                      setSelectedId(node.id);
                      setSelectedEdgeId("");
                      event.currentTarget.focus();
                      gesture.current = {
                        kind: "node",
                        id: node.id,
                        start: { x: event.clientX, y: event.clientY },
                        base: { x: node.x, y: node.y },
                        delta: { x: 0, y: 0 },
                        moved: false,
                        pointerId: event.pointerId,
                      };
                      capture(event);
                    }}
                  >
                    {editable && node.type !== "end" && (
                      <button
                        className="node-port node-port-out"
                        type="button"
                        aria-label={`从${node.name}开始连线`}
                        title="拖至目标节点，或点击后选择目标"
                        onPointerDown={(event) => {
                          event.stopPropagation();
                          event.preventDefault();
                          setConnectingFrom(node.id);
                          setPointer(pointAt(event.clientX, event.clientY));
                          gesture.current = {
                            kind: "connect",
                            start: { x: event.clientX, y: event.clientY },
                            moved: false,
                            pointerId: event.pointerId,
                          };
                          capture(event);
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (event.detail === 0) {
                            setConnectingFrom(node.id);
                            const size = nodeSize(node);
                            setPointer({
                              x: node.x + size.width + 70,
                              y: node.y + size.height / 2,
                            });
                          }
                        }}
                      />
                    )}
                    {node.type === "start" || node.type === "end" ? (
                      <span className="event-label">{node.name}</span>
                    ) : node.type === "gateway" ? (
                      <>
                        <Diamond size={34} />
                        <span>{node.name}</span>
                      </>
                    ) : (
                      <>
                        <span className="node-type-icon">
                          {node.type === "userTask" ? (
                            <UserRound size={16} />
                          ) : (
                            <Bot size={16} />
                          )}
                        </span>
                        <span>{node.name}</span>
                        <small>
                          {node.assignee ||
                            (node.candidates?.length
                              ? "已配置候选处理人"
                              : node.callback ||
                                (node.type === "userTask"
                                  ? "未设置负责人"
                                  : "未设置服务"))}
                        </small>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
        <aside className="properties-panel">
          <div className="designer-pane-title">
            <span>{selectedEdge ? "连线属性" : "元素属性"}</span>
            <small>
              {readOnly
                ? "当前版本只读"
                : selected
                  ? "已选择节点"
                  : selectedEdge
                    ? "已选择连线"
                    : "选择画布元素"}
            </small>
          </div>
          <fieldset className="process-properties" disabled={!editable}>
            {selected ? (
              <NodeProperties
                node={selected}
                update={updateSelected}
                remove={deleteSelected}
                directoryUsers={directoryUsers}
                departmentOptions={departmentOptions}
                roleOptions={roleOptions}
              />
            ) : selectedEdge ? (
              <div className="property-form">
                <label>
                  <span>连线名称</span>
                  <input
                    aria-label="连线名称"
                    value={selectedEdge.label ?? ""}
                    onChange={(event) =>
                      commit({
                        ...definition,
                        edges: definition.edges.map((edge) =>
                          edge.id === selectedEdge.id
                            ? { ...edge, label: event.target.value }
                            : edge,
                        ),
                      })
                    }
                  />
                </label>
                <p>
                  {nodesById.get(selectedEdge.source)?.name} →{" "}
                  {nodesById.get(selectedEdge.target)?.name}
                </p>
                <label><span>结果条件</span><select aria-label="结果条件" value={selectedEdge.outcome ?? ""} onChange={event => commit({ ...definition, edges: definition.edges.map(edge => edge.id === selectedEdge.id ? { ...edge, outcome: event.target.value } : edge) })}>
                  <option value="">默认出口</option><option value="passed">审核通过</option><option value="rejected">审核退回</option><option value="succeeded">执行成功</option><option value="failed">执行失败</option><option value="timeout">等待超时</option>
                  <option value="needs-review">需要人工复核</option><option value="cancelled">审查取消</option><option value="request-rejected">请求登记被拒绝</option>
                </select></label>
                <button
                  type="button"
                  className="delete-node"
                  onClick={() => {
                    commit(removeProcessEdge(definition, selectedEdge.id));
                    setSelectedEdgeId("");
                  }}
                >
                  <Trash2 size={16} />
                  删除连线
                </button>
              </div>
            ) : (
              <div className="property-form">
                <label>
                  <span>流程名称</span>
                  <input
                    aria-label="流程名称"
                    maxLength={150}
                    value={definition.name}
                    onChange={(event) =>
                      commit({ ...definition, name: event.target.value })
                    }
                  />
                </label>
                <p>点击节点或连线编辑属性。已发布版本需要复制后修改。</p>
                <label><span><input type="checkbox" checked={definition.executionMode === "integrated-v1"} onChange={event => commit({ ...definition, executionMode: event.target.checked ? "integrated-v1" : undefined })} /> 启用第三方流程执行</span></label>
                <p>启用后按连线执行服务节点；请为人工任务、服务任务和结束节点配置结果。</p>
              </div>
            )}
          </fieldset>
          {validation && (
            <div
              className={`validation-card ${validation.length ? "has-errors" : "is-success"}`}
              role="status"
            >
              <div>
                <strong>
                  {validation.length
                    ? `发现 ${validation.length} 个问题`
                    : "流程校验通过"}
                </strong>
                {validation.map((item) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
      {publishOpen && (
        <Modal
          title={`发布 V${record.version}`}
          onClose={() => {
            if (!busy) setPublishOpen(false);
          }}
        >
          <div className="entity-form">
            <p>
              发布将保存并锁定当前草稿，新申请使用此版本。已经启动的实例继续使用原版本。
            </p>
            {error && (
              <div className="model-form-error" role="alert">
                {error}
              </div>
            )}
            <footer className="modal-actions">
              <button
                type="button"
                className="secondary-action"
                disabled={busy}
                onClick={() => setPublishOpen(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-action"
                disabled={busy}
                onClick={() => void persist(true)}
              >
                {busy ? "正在发布…" : "确认发布"}
              </button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NodeProperties({
  node,
  update,
  remove,
  directoryUsers,
  departmentOptions,
  roleOptions,
}: {
  node: ProcessNode;
  update: (patch: Partial<ProcessNode>) => void;
  remove: () => void;
  directoryUsers: typeof fallbackDirectoryUsers;
  departmentOptions: DesignerOption[];
  roleOptions: DesignerOption[];
}) {
  const nodeType = palette.find((item) => item.type === node.type);
  const assignmentType = node.candidates?.length
    ? "legacy"
    : (node.assignmentType ?? "department");
  const changeAssignmentType = (value: string) => {
    const type = value as AssignmentType;
    update({
      assignmentType: type,
      assignee:
        type === "department"
          ? (departmentOptions[0]?.value ?? "digital")
          : type === "role"
            ? (roleOptions[0]?.value ?? "normal-user")
            : type === "initiator"
              ? "流程发起人"
              : "",
      assigneeIds: type === "users" ? [] : undefined,
      candidates: undefined,
    });
  };
  return (
    <div className="property-form">
      <div className="selected-type">
        <span className={`palette-icon type-${node.type}`}>
          {node.type === "gateway" ? (
            <Diamond size={18} />
          ) : node.type === "userTask" ? (
            <UserRound size={18} />
          ) : node.type === "serviceTask" ? (
            <Bot size={18} />
          ) : (
            <Circle size={18} />
          )}
        </span>
        <div>
          <strong>{nodeType?.label}</strong>
          <small>ID: {node.id}</small>
        </div>
      </div>
      <label>
        <span>节点名称</span>
        <input
          value={node.name}
          onChange={(event) => update({ name: event.target.value })}
        />
      </label>
      {node.type === "userTask" && (
        <div className="assignment-panel">
          <div className="property-field">
            <span>分配方式</span>
            <ModernSelect
              ariaLabel="分配方式"
              value={assignmentType}
              options={
                node.candidates?.length
                  ? [
                      { value: "legacy", label: "原有候选处理人" },
                      ...assignmentOptions,
                    ]
                  : assignmentOptions
              }
              onChange={changeAssignmentType}
            />
          </div>
          {assignmentType === "legacy" && (
            <div className="assignment-hint">
              <span>
                保留原有候选处理人：{node.candidates?.join("、")}
                。切换分配方式后将替换原配置。
              </span>
            </div>
          )}
          {assignmentType === "users" && (
            <div className="property-field">
              <span>域控人员</span>
              <DirectoryUserPicker
                users={directoryUsers}
                selectedIds={node.assigneeIds ?? []}
                onChange={(ids) =>
                  update({
                    candidates: undefined,
                    assigneeIds: ids,
                    assignee: directoryUsers
                      .filter((user) => ids.includes(user.id))
                      .map((user) => user.name)
                      .join("、"),
                  })
                }
              />
            </div>
          )}
          {assignmentType === "department" && (
            <div className="property-field">
              <span>处理部门</span>
              <ModernSelect
                ariaLabel="处理部门"
                value={
                  node.assignee || departmentOptions[0]?.value || "digital"
                }
                options={departmentOptions}
                onChange={(assignee) =>
                  update({ assignee, candidates: undefined })
                }
              />
            </div>
          )}
          {assignmentType === "role" && (
            <div className="property-field">
              <span>平台角色</span>
              <ModernSelect
                ariaLabel="平台角色"
                value={node.assignee || roleOptions[0]?.value || "normal-user"}
                options={roleOptions}
                onChange={(assignee) =>
                  update({ assignee, candidates: undefined })
                }
              />
            </div>
          )}
          {assignmentType === "initiator" && (
            <div className="assignment-hint">
              <UserRound size={15} />
              <span>任务将自动分配给当前流程的申请提交人。</span>
            </div>
          )}
          <div className="notification-setting">
            <div>
              <strong>发送站内信</strong>
              <small>任务到达时通知处理人；真实消息服务后续接入</small>
            </div>
            <button
              type="button"
              role="switch"
              aria-label="发送站内信"
              aria-checked={node.notifyInbox !== false}
              className={node.notifyInbox !== false ? "is-on" : ""}
              onClick={() =>
                update({ notifyInbox: node.notifyInbox === false })
              }
            >
              <span />
            </button>
          </div>
        </div>
      )}
      {node.type === "serviceTask" && (
        <><IntegrationNodeProperties node={node} update={update} /><label>
          <span>执行服务 / Agent</span>
          <input
            value={node.assignee || ""}
            placeholder="选择 Agent 或服务"
            onChange={(event) => update({ assignee: event.target.value })}
          />
        </label></>
      )}
      {node.type === "end" && <label><span>结束结果</span><select aria-label="结束结果" value={node.result ?? ""} onChange={event => update({ result: event.target.value as ProcessNode["result"] })}><option value="">请选择</option><option value="Approved">发布完成</option><option value="Rejected">退回申请</option><option value="Failed">流程失败</option></select></label>}
      {node.type === "gateway" && (
        <label>
          <span>条件表达式</span>
          <textarea
            rows={3}
            value={node.condition || ""}
            onChange={(event) => update({ condition: event.target.value })}
          />
        </label>
      )}
      <label>
        <span>说明</span>
        <textarea
          rows={4}
          placeholder="补充节点处理说明"
          value={node.description || ""}
          onChange={(event) => update({ description: event.target.value })}
        />
      </label>
      <button className="delete-node" type="button" onClick={remove}>
        <Trash2 size={16} />
        删除此元素
      </button>
    </div>
  );
}
