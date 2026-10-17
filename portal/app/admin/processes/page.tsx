"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Diamond,
  Focus,
  MousePointer2,
  Redo2,
  Save,
  Send,
  Square,
  Trash2,
  Undo2,
  UserRound,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { DirectoryUserPicker } from "../../components/directory-user-picker";
import { ModernSelect } from "../../components/modern-select";
import { createInitialPlatformState } from "../../lib/platform-state";
import {
  getDesignerOptions,
  getProcessDefinitions,
  hasBackend,
  saveProcessDefinition,
  type DesignerOption,
} from "../../lib/api-client";
import {
  addProcessEdge,
  createProcessHistory,
  processHistoryReducer,
  validateProcess,
} from "../../lib/process-history";
import {
  sampleProcess,
  type AssignmentType,
  type ProcessNode,
  type ProcessNodeType,
} from "../../lib/process-types";

const palette: Array<{
  type: ProcessNodeType;
  label: string;
  icon: typeof Circle;
}> = [
  { type: "start", label: "开始事件", icon: Circle },
  { type: "end", label: "结束事件", icon: Circle },
  { type: "userTask", label: "用户任务", icon: UserRound },
  { type: "serviceTask", label: "服务任务", icon: Bot },
  { type: "gateway", label: "排他网关", icon: Diamond },
];
const fallbackDirectoryUsers = createInitialPlatformState().users.filter(
  (user) => user.status === "启用",
);
const assignmentOptions = [
  { value: "users", label: "指定域用户", description: "按姓名或工号选择人员" },
  { value: "department", label: "按部门分配", description: "部门成员均可领取" },
  { value: "role", label: "按平台角色", description: "匹配具备指定角色的用户" },
  {
    value: "initiator",
    label: "流程发起人",
    description: "自动回到申请提交人",
  },
];
const fallbackDepartmentOptions = [
  "数字化办公室",
  "人力资源部",
  "质量管理部",
  "研发中心",
  "法务部",
].map((label) => ({ value: label, label }));
const fallbackRoleOptions = ["普通用户", "流程管理员", "平台管理员"].map((label) => ({
  value: label,
  label,
}));
const nodeCenter = (node: ProcessNode) => ({
  x:
    node.x +
    (node.type === "start" || node.type === "end"
      ? 24
      : node.type === "gateway"
        ? 34
        : 70),
  y:
    node.y +
    (node.type === "start" || node.type === "end"
      ? 24
      : node.type === "gateway"
        ? 34
        : 31),
});

export default function ProcessDesignerPage() {
  const [history, dispatch] = useReducer(
    processHistoryReducer,
    sampleProcess,
    createProcessHistory,
  );
  const [selectedId, setSelectedId] = useState("review");
  const [scale, setScale] = useState(1);
  const [message, setMessage] = useState("所有更改已保存");
  const [validation, setValidation] = useState<string[] | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    startX: number;
    startY: number;
    baseX: number;
    baseY: number;
  } | null>(null);
  const [dragDelta, setDragDelta] = useState({ x: 0, y: 0 });
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null);
  const [directoryUsers, setDirectoryUsers] = useState(fallbackDirectoryUsers);
  const [departmentOptions, setDepartmentOptions] = useState<DesignerOption[]>(fallbackDepartmentOptions);
  const [roleOptions, setRoleOptions] = useState<DesignerOption[]>(fallbackRoleOptions);
  const [latestVersion, setLatestVersion] = useState(0);
  const nodeCounter = useRef(sampleProcess.nodes.length + 1);
  const definition = history.present;
  const selected =
    definition.nodes.find((node) => node.id === selectedId) ?? null;
  const nodesById = useMemo(
    () => new Map(definition.nodes.map((node) => [node.id, node])),
    [definition.nodes],
  );

  useEffect(() => {
    if (!hasBackend || !localStorage.getItem("aigc_hub_access_token")) return;
    Promise.all([getProcessDefinitions(), getDesignerOptions()])
      .then(([definitions, options]) => {
        setLatestVersion(Math.max(0, ...definitions.map((item) => item.version)));
        const active = definitions.find((item) => item.isPublished) ?? definitions[0];
        if (active) {
          const parsed = JSON.parse(active.definitionJson) as typeof sampleProcess;
          if (parsed.nodes?.every((node) => typeof node.x === "number") && parsed.edges)
            dispatch({ type: "reset", definition: parsed });
        }
        setDirectoryUsers(options.users.map((user) => ({
          id: user.value, name: user.label, employeeNo: user.employeeNo ?? "", department: "企业目录",
          email: "", role: "", status: "启用" as const, lastLogin: "",
        })));
        setDepartmentOptions(options.departments);
        setRoleOptions(options.roles);
        setMessage("已加载当前已发布流程");
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);

  const commit = (nodes: ProcessNode[]) => {
    dispatch({ type: "commit", definition: { ...definition, nodes } });
    setMessage("存在未保存的更改");
  };
  const connectTo = (target: string) => {
    if (!connectingFrom) return;
    const next = addProcessEdge(definition, connectingFrom, target);
    setMessage(
      next === definition ? "该连线已存在或不能连接到自身" : "已创建连线",
    );
    if (next !== definition) dispatch({ type: "commit", definition: next });
    setConnectingFrom(null);
  };
  const updateSelected = (patch: Partial<ProcessNode>) =>
    selected &&
    commit(
      definition.nodes.map((node) =>
        node.id === selected.id ? { ...node, ...patch } : node,
      ),
    );
  const addNode = (type: ProcessNodeType) => {
    const names: Record<ProcessNodeType, string> = {
      start: "开始事件",
      end: "结束事件",
      userTask: "新用户任务",
      serviceTask: "新服务任务",
      gateway: "条件判断",
    };
    const count = definition.nodes.length;
    const node: ProcessNode = {
      id: `node-${nodeCounter.current++}`,
      type,
      name: names[type],
      x: 180 + (count % 4) * 150,
      y: 390 + Math.floor(count / 4) * 90,
      ...(type === "userTask"
        ? {
            assignmentType: "users" as AssignmentType,
            assigneeIds: [],
            notifyInbox: true,
          }
        : {}),
    };
    commit([...definition.nodes, node]);
    setSelectedId(node.id);
  };
  const deleteSelected = () => {
    if (!selected) return;
    dispatch({
      type: "commit",
      definition: {
        ...definition,
        nodes: definition.nodes.filter((node) => node.id !== selected.id),
        edges: definition.edges.filter(
          (edge) => edge.source !== selected.id && edge.target !== selected.id,
        ),
      },
    });
    setSelectedId("");
    setMessage("节点已删除");
  };
  const finishDrag = () => {
    if (drag && (dragDelta.x || dragDelta.y))
      commit(
        definition.nodes.map((node) =>
          node.id === drag.id
            ? {
                ...node,
                x: Math.max(0, drag.baseX + dragDelta.x / scale),
                y: Math.max(0, drag.baseY + dragDelta.y / scale),
              }
            : node,
        ),
      );
    setDrag(null);
    setDragDelta({ x: 0, y: 0 });
  };
  const runValidation = () => {
    const errors = validateProcess(definition);
    setValidation(errors);
    setMessage(errors.length ? "流程校验未通过" : "流程校验通过");
  };
  const persist = async (isPublished: boolean) => {
    if (!hasBackend) {
      setMessage(isPublished ? "流程 V1.4 已发布" : "已于刚刚保存");
      return;
    }
    setMessage(isPublished ? "正在发布…" : "正在保存…");
    try {
      const saved = await saveProcessDefinition({
        key: "application-publishing", name: definition.name,
        version: latestVersion + 1, definition, isPublished,
      });
      setLatestVersion(saved.version);
      setMessage(isPublished ? `流程 V${saved.version} 已发布` : `草稿 V${saved.version} 已保存`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存流程失败");
    }
  };
  const save = () => void persist(false);
  const publish = () => {
    const errors = validateProcess(definition);
    setValidation(errors);
    setMessage(errors.length ? "请先修复校验问题" : "正在发布…");
    if (!errors.length) void persist(true);
  };

  return (
    <div className="process-page page-enter">
      <div className="process-toolbar">
        <div className="process-title">
          <span className="process-status-dot" />
          <div>
            <h1>{definition.name}</h1>
            <span role="status">{message}</span>
          </div>
        </div>
        <div className="process-toolbar__actions">
          <button
            type="button"
            aria-label="撤销"
            disabled={!history.past.length}
            onClick={() => dispatch({ type: "undo" })}
          >
            <Undo2 size={17} />
          </button>
          <button
            type="button"
            aria-label="重做"
            disabled={!history.future.length}
            onClick={() => dispatch({ type: "redo" })}
          >
            <Redo2 size={17} />
          </button>
          <span className="tool-divider" />
          <button type="button" onClick={runValidation}>
            <CheckCircle2 size={17} />
            校验
          </button>
          <button type="button" onClick={save}>
            <Save size={17} />
            保存
          </button>
          <button className="primary-action" type="button" onClick={publish}>
            <Send size={17} />
            发布流程
          </button>
        </div>
      </div>
      <div className="designer-shell">
        <aside className="node-palette">
          <div className="designer-pane-title">
            <span>流程元素</span>
            <small>点击添加至画布</small>
          </div>
          <PaletteSection
            title="事件"
            items={palette.slice(0, 2)}
            onAdd={addNode}
          />
          <PaletteSection
            title="任务"
            items={palette.slice(2, 4)}
            onAdd={addNode}
          />
          <PaletteSection
            title="网关"
            items={palette.slice(4)}
            onAdd={addNode}
          />
          <div className="palette-tip">
            <MousePointer2 size={16} />
            <span>点击元素添加，拖动节点调整流程布局。</span>
          </div>
        </aside>
        <section className="process-canvas-wrap">
          <div className="canvas-tools">
            <button
              type="button"
              aria-label="缩小"
              onClick={() => setScale(Math.max(0.65, scale - 0.1))}
            >
              <ZoomOut size={17} />
            </button>
            <span>{Math.round(scale * 100)}%</span>
            <button
              type="button"
              aria-label="放大"
              onClick={() => setScale(Math.min(1.35, scale + 0.1))}
            >
              <ZoomIn size={17} />
            </button>
            <button
              type="button"
              aria-label="适应画布"
              onClick={() => setScale(1)}
            >
              <Focus size={17} />
            </button>
          </div>
          <div
            className="process-canvas"
            onPointerMove={(event) =>
              drag &&
              setDragDelta({
                x: event.clientX - drag.startX,
                y: event.clientY - drag.startY,
              })
            }
            onPointerUp={finishDrag}
            onPointerLeave={finishDrag}
          >
            <div
              className="canvas-stage"
              style={{ transform: `scale(${scale})` }}
            >
              <ProcessEdges nodesById={nodesById} edges={definition.edges} />
              {definition.nodes.map((node) => {
                const moving = drag?.id === node.id;
                const dx = moving ? dragDelta.x / scale : 0;
                const dy = moving ? dragDelta.y / scale : 0;
                return (
                  <ProcessNodeButton
                    key={node.id}
                    node={node}
                    selected={node.id === selectedId}
                    connecting={connectingFrom === node.id}
                    x={node.x + dx}
                    y={node.y + dy}
                    onStartConnection={() => {
                      setConnectingFrom(node.id);
                      setMessage(`请选择“${node.name}”的目标节点`);
                    }}
                    onFinishConnection={() => connectTo(node.id)}
                    onClick={() => setSelectedId(node.id)}
                    onPointerDown={(event) => {
                      if ((event.target as HTMLElement).closest(".node-port"))
                        return;
                      event.preventDefault();
                      setSelectedId(node.id);
                      setDrag({
                        id: node.id,
                        startX: event.clientX,
                        startY: event.clientY,
                        baseX: node.x,
                        baseY: node.y,
                      });
                    }}
                  />
                );
              })}
            </div>
          </div>
        </section>
        <aside className="properties-panel">
          <div className="designer-pane-title">
            <span>元素属性</span>
            <small>{selected ? "已选择节点" : "选择画布节点"}</small>
          </div>
          {selected ? (
            <NodeProperties
              node={selected}
              update={updateSelected}
              remove={deleteSelected}
              directoryUsers={directoryUsers}
              departmentOptions={departmentOptions}
              roleOptions={roleOptions}
            />
          ) : (
            <div className="no-selection">
              <Square size={28} />
              <p>选择一个流程元素后，可在这里修改其名称和执行属性。</p>
            </div>
          )}
          {validation && (
            <div
              className={`validation-card${validation.length ? " has-errors" : " is-success"}`}
            >
              {validation.length ? (
                <>
                  <XCircle size={18} />
                  <div>
                    <strong>发现 {validation.length} 个问题</strong>
                    {validation.map((error) => (
                      <span key={error}>{error}</span>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <Check size={18} />
                  <div>
                    <strong>流程校验通过</strong>
                    <span>可以安全发布当前版本。</span>
                  </div>
                </>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function PaletteSection({
  title,
  items,
  onAdd,
}: {
  title: string;
  items: typeof palette;
  onAdd: (type: ProcessNodeType) => void;
}) {
  return (
    <div className="palette-section">
      <strong>{title}</strong>
      {items.map(({ type, label, icon: Icon }) => (
        <button
          type="button"
          key={type}
          aria-label={`添加${label}`}
          onClick={() => onAdd(type)}
        >
          <span className={`palette-icon type-${type}`}>
            <Icon size={19} />
          </span>
          <span>
            {label}
            <small>
              {type === "start"
                ? "流程入口"
                : type === "end"
                  ? "流程出口"
                  : type === "userTask"
                    ? "人工处理节点"
                    : type === "serviceTask"
                      ? "Agent / 系统任务"
                      : "条件分支"}
            </small>
          </span>
        </button>
      ))}
    </div>
  );
}

function ProcessEdges({
  nodesById,
  edges,
}: {
  nodesById: Map<string, ProcessNode>;
  edges: typeof sampleProcess.edges;
}) {
  return (
    <svg className="process-edges" width="1040" height="620" aria-hidden="true">
      <defs>
        <marker
          id="arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      {edges.map((edge) => {
        const source = nodesById.get(edge.source);
        const target = nodesById.get(edge.target);
        if (!source || !target) return null;
        const a = nodeCenter(source);
        const b = nodeCenter(target);
        const mid = (a.x + b.x) / 2;
        return (
          <g key={edge.id}>
            <path
              d={`M ${a.x} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${b.x} ${b.y}`}
              markerEnd="url(#arrow)"
            />
            {edge.label && (
              <text x={mid} y={(a.y + b.y) / 2 - 8}>
                {edge.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function ProcessNodeButton({
  node,
  selected,
  connecting,
  x,
  y,
  onClick,
  onPointerDown,
  onStartConnection,
  onFinishConnection,
}: {
  node: ProcessNode;
  selected: boolean;
  connecting: boolean;
  x: number;
  y: number;
  onClick: () => void;
  onPointerDown: (event: React.PointerEvent) => void;
  onStartConnection: () => void;
  onFinishConnection: () => void;
}) {
  return (
    <div
      data-testid="process-node"
      role="button"
      tabIndex={0}
      aria-label={node.name}
      className={`process-node type-${node.type}${selected ? " is-selected" : ""}${connecting ? " is-connecting" : ""}`}
      style={{ transform: `translate(${x}px,${y}px)` }}
      onClick={onClick}
      onPointerDown={onPointerDown}
    >
      <button
        type="button"
        className="node-port node-port-in"
        aria-label={`连接到${node.name}`}
        onPointerUp={(event) => {
          event.stopPropagation();
          onFinishConnection();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onFinishConnection();
        }}
      />
      <button
        type="button"
        className="node-port node-port-out"
        aria-label={`从${node.name}开始连线`}
        onPointerDown={(event) => {
          event.stopPropagation();
          onStartConnection();
        }}
        onClick={(event) => {
          event.stopPropagation();
          onStartConnection();
        }}
      />
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
          <small>{node.assignee || "未设置负责人"}</small>
        </>
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
  const assignmentType = node.assignmentType ?? "department";
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
              options={assignmentOptions}
              onChange={changeAssignmentType}
            />
          </div>
          {assignmentType === "users" && (
            <div className="property-field">
              <span>域控人员</span>
              <DirectoryUserPicker
                users={directoryUsers}
                selectedIds={node.assigneeIds ?? []}
                onChange={(ids) =>
                  update({
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
                value={node.assignee || departmentOptions[0]?.value || "digital"}
                options={departmentOptions}
                onChange={(assignee) => update({ assignee })}
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
                onChange={(assignee) => update({ assignee })}
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
        <label>
          <span>执行服务 / Agent</span>
          <input
            value={node.assignee || ""}
            placeholder="选择 Agent 或服务"
            onChange={(event) => update({ assignee: event.target.value })}
          />
        </label>
      )}
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
