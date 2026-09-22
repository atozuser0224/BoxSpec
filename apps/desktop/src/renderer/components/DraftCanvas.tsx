import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type { CanvasNode, EditorCommand, EditorScreen, ReviewDetail } from "../../common/ipc";
import "./DraftCanvas.css";

export type ResizeEdge = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type Alignment = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";
export type DistributionAxis = "horizontal" | "vertical";

export type DraftCanvasCommand =
  | EditorCommand
  | { type: "resize-node"; nodeId: string; edge: ResizeEdge; deltaX: number; deltaY: number }
  | { type: "group-selected"; nodeIds: string[] }
  | { type: "reparent-node"; nodeId: string; parentId: string; order: number }
  | { type: "ungroup-selected"; nodeIds: string[] }
  | { type: "align-selected"; nodeIds: string[]; alignment: Alignment }
  | { type: "distribute-selected"; nodeIds: string[]; axis: DistributionAxis };

export interface DraftCanvasProps {
  contract: EditorScreen;
  selectedIds: string[];
  zoom: number;
  tool: "select" | "region" | "pan";
  review: ReviewDetail | null;
  onSelectionChange(ids: string[]): void;
  onCommand(command: DraftCanvasCommand): void;
  onZoom(value: number): void;
}

interface Point { x: number; y: number }
interface Bounds { width: number; height: number }

type Interaction =
  | { kind: "move"; pointerId: number; origin: Point; nodeIds: string[]; delta: Point; dropParentId: string | null }
  | { kind: "resize"; pointerId: number; origin: Point; nodeId: string; edge: ResizeEdge; delta: Point }
  | { kind: "region"; pointerId: number; origin: Point; parentId: string; rect: { x: number; y: number; width: number; height: number } }
  | { kind: "pan"; pointerId: number; clientOrigin: Point; scrollOrigin: Point };

const CANVAS_WIDTH = 1440;
const CANVAS_HEIGHT = 900;
const RESIZE_EDGES: ResizeEdge[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
const DRAG_THRESHOLD = 2;
const SAFE_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function themeColor(contract: EditorScreen, name: string, fallback: string): string {
  const token = contract.designSystem.tokens[name];
  return token?.type === "color" && SAFE_COLOR.test(token.value) ? token.value : fallback;
}

function clampZoom(value: number): number {
  return Math.min(1.5, Math.max(0.2, value));
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function nodeSizing(node: CanvasNode, parentMode?: CanvasNode["layout"]["mode"]): CSSProperties {
  const main = parentMode === "row" ? node.layout.width : node.layout.height;
  const flex = main.mode === "fixed"
    ? `0 0 ${main.value ?? 0}px`
    : main.mode === "fill"
      ? `${main.weight ?? 1} 1 ${main.min ?? 0}px`
      : "0 1 auto";
  return {
    flex: parentMode === "row" || parentMode === "column" ? flex : undefined,
    width: node.layout.width.mode === "fixed"
      ? node.layout.width.value
      : parentMode !== "row" && node.layout.width.mode === "fill"
        ? "100%"
        : undefined,
    height: node.layout.height.mode === "fixed"
      ? node.layout.height.value
      : parentMode !== "column" && node.layout.height.mode === "fill"
        ? "100%"
        : undefined,
    minWidth: node.layout.width.min,
    minHeight: node.layout.height.min,
    maxWidth: node.layout.width.max,
    maxHeight: node.layout.height.max,
  };
}

function nodeStyle(
  node: CanvasNode,
  parentMode: CanvasNode["layout"]["mode"] | undefined,
  isRoot: boolean,
  moveDelta: Point | null,
  resize: { edge: ResizeEdge; delta: Point; bounds: Bounds } | null,
): CSSProperties {
  const placement = node.placement.kind === "anchor" ? node.placement : null;
  let translateX = moveDelta?.x ?? 0;
  let translateY = moveDelta?.y ?? 0;
  let width: CSSProperties["width"];
  let height: CSSProperties["height"];

  if (resize) {
    if (resize.edge.includes("w")) translateX += resize.delta.x;
    if (resize.edge.includes("n")) translateY += resize.delta.y;
    width = Math.max(8, resize.bounds.width + (resize.edge.includes("e") ? resize.delta.x : resize.edge.includes("w") ? -resize.delta.x : 0));
    height = Math.max(8, resize.bounds.height + (resize.edge.includes("s") ? resize.delta.y : resize.edge.includes("n") ? -resize.delta.y : 0));
  }

  const resizedFlex = resize && parentMode === "row"
    ? `0 0 ${String(width ?? resize.bounds.width)}px`
    : resize && parentMode === "column"
      ? `0 0 ${String(height ?? resize.bounds.height)}px`
      : undefined;

  return {
    ...nodeSizing(node, parentMode),
    ...(isRoot ? { width: "100%", height: "100%", flex: "none" } : {}),
    ...(resizedFlex ? { flex: resizedFlex } : {}),
    ...(placement ? {
      position: "absolute",
      left: placement.anchorX === "left" ? placement.offsetX : placement.anchorX === "right" ? undefined : "50%",
      right: placement.anchorX === "right" ? placement.offsetX : undefined,
      top: placement.anchorY === "top" ? placement.offsetY : placement.anchorY === "bottom" ? undefined : "50%",
      bottom: placement.anchorY === "bottom" ? placement.offsetY : undefined,
      zIndex: placement.zIndex,
    } : { position: "relative" }),
    display: node.visible === false ? "none" : node.layout.mode === "grid" ? "grid" : "flex",
    flexDirection: node.layout.mode === "row" ? "row" : "column",
    gridTemplateColumns: node.layout.mode === "grid" ? `repeat(${node.layout.gridColumns ?? 2}, minmax(0, 1fr))` : undefined,
    gap: node.layout.gap,
    padding: `${node.layout.padding.top}px ${node.layout.padding.right}px ${node.layout.padding.bottom}px ${node.layout.padding.left}px`,
    alignItems: node.layout.align === "start" ? "flex-start" : node.layout.align === "end" ? "flex-end" : node.layout.align,
    justifyContent: node.layout.justify === "start" ? "flex-start" : node.layout.justify === "end" ? "flex-end" : node.layout.justify,
    transform: translateX || translateY ? `translate(${translateX}px, ${translateY}px)` : undefined,
    width: width ?? (isRoot ? "100%" : nodeSizing(node, parentMode).width),
    height: height ?? (isRoot ? "100%" : nodeSizing(node, parentMode).height),
  };
}

interface NodeViewProps {
  node: CanvasNode;
  nodes: CanvasNode[];
  parentMode?: CanvasNode["layout"]["mode"];
  rootId: string;
  selected: ReadonlySet<string>;
  primaryId: string | null;
  interaction: Interaction | null;
  measurements: ReadonlyMap<string, Bounds>;
}

function NodeView({ node, nodes, parentMode, rootId, selected, primaryId, interaction, measurements }: NodeViewProps) {
  const children = nodes.filter((entry) => entry.parentId === node.id).sort((a, b) => a.order - b.order);
  const moveDelta = interaction?.kind === "move" && interaction.nodeIds.includes(node.id) ? interaction.delta : null;
  const measured = measurements.get(node.id);
  const resize = interaction?.kind === "resize" && interaction.nodeId === node.id && measured
    ? { edge: interaction.edge, delta: interaction.delta, bounds: measured }
    : null;
  const hard = node.locks.some((lock) => lock.policy === "hard");
  const isSelected = selected.has(node.id);
  const isDropParent = interaction?.kind === "move" && interaction.dropParentId === node.id;
  return (
    <div
      className={`draft-canvas-node ${node.id === rootId ? "is-root" : ""} ${isSelected ? "is-selected" : ""} ${primaryId === node.id ? "is-primary" : ""} ${children.length === 0 ? "is-leaf" : ""} ${isDropParent ? "is-drop-parent" : ""}`}
      style={nodeStyle(node, parentMode, node.id === rootId, moveDelta, resize)}
      data-node-id={node.id}
      data-testid={`canvas-node-${node.id}`}
      data-selected={isSelected ? "true" : "false"}
      data-drop-parent={isDropParent ? "true" : undefined}
    >
      <span className="draft-node-label">
        <strong>{node.name}</strong>
        <small>{measured ? `${Math.round(measured.width)} × ${Math.round(measured.height)}` : node.role}</small>
        {hard && <span className="draft-node-lock">Hard</span>}
      </span>
      {children.map((child) => (
        <NodeView
          key={child.id}
          node={child}
          nodes={nodes}
          parentMode={node.layout.mode}
          rootId={rootId}
          selected={selected}
          primaryId={primaryId}
          interaction={interaction}
          measurements={measurements}
        />
      ))}
      {isSelected && node.id !== rootId && RESIZE_EDGES.map((edge) => (
        <span
          key={edge}
          className={`draft-resize-handle edge-${edge}`}
          data-resize-edge={edge}
          data-resize-node-id={node.id}
          data-testid={`resize-${node.id}-${edge}`}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}

function topLevelSelection(ids: string[], byId: ReadonlyMap<string, CanvasNode>): string[] {
  const selected = new Set(ids);
  return ids.filter((id) => {
    let node = byId.get(id);
    const seen = new Set<string>();
    while (node?.parentId && !seen.has(node.parentId)) {
      if (selected.has(node.parentId)) return false;
      seen.add(node.parentId);
      node = byId.get(node.parentId);
    }
    return true;
  });
}

export function DraftCanvas({ contract, selectedIds, zoom, tool, review, onSelectionChange, onCommand, onZoom }: DraftCanvasProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLElement>(null);
  const composingRef = useRef(false);
  const spacePressedRef = useRef(false);
  const movedRef = useRef(false);
  const [interaction, setInteraction] = useState<Interaction | null>(null);
  const [measurements, setMeasurements] = useState<Map<string, Bounds>>(new Map());
  const [alignment, setAlignment] = useState<Alignment>("left");
  const [distributionAxis, setDistributionAxis] = useState<DistributionAxis>("horizontal");
  const [reparentTargetId, setReparentTargetId] = useState("");
  const root = useMemo(() => contract.nodes.find((node) => node.id === contract.rootNodeId), [contract]);
  const byId = useMemo(() => new Map(contract.nodes.map((node) => [node.id, node])), [contract.nodes]);
  const selected = useMemo(() => new Set(selectedIds.filter((id) => byId.has(id))), [byId, selectedIds]);
  const primaryId = selectedIds.length > 0 ? selectedIds[selectedIds.length - 1] ?? null : null;
  const movableIds = useMemo(() => topLevelSelection(selectedIds, byId).filter((id) => id !== contract.rootNodeId), [byId, contract.rootNodeId, selectedIds]);
  const groupableIds = useMemo(() => {
    if (movableIds.length < 2) return [];
    const parentId = byId.get(movableIds[0]!)?.parentId;
    return movableIds.every((id) => byId.get(id)?.parentId === parentId) ? movableIds : [];
  }, [byId, movableIds]);
  const arrangeableIds = useMemo(() => {
    if (movableIds.length < 2) return [];
    const first = byId.get(movableIds[0]!);
    if (!first) return [];
    return movableIds.every((id) => {
      const node = byId.get(id);
      return node?.parentId === first.parentId
        && node.placement.kind === "anchor"
        && node.placement.anchorX === "left"
        && node.placement.anchorY === "top"
        && node.layout.width.mode === "fixed"
        && node.layout.height.mode === "fixed";
    }) ? movableIds : [];
  }, [byId, movableIds]);
  const ungroupableIds = useMemo(() => {
    const candidates = movableIds.filter((id) => {
      const node = byId.get(id);
      return node?.role === "container"
        && node.layout.mode === "overlay"
        && contract.nodes.some((entry) => entry.parentId === id);
    });
    const selectedGroups = new Set(candidates);
    return candidates.some((id) => contract.nodes.some((entry) => entry.parentId === id && selectedGroups.has(entry.id))) ? [] : candidates;
  }, [byId, contract.nodes, movableIds]);
  const reparentOptions = useMemo(() => {
    if (movableIds.length !== 1) return [];
    const movingId = movableIds[0]!;
    const moving = byId.get(movingId);
    if (!moving) return [];
    const forbidden = new Set([movingId]);
    for (const node of contract.nodes) {
      let current: CanvasNode | undefined = node;
      const seen = new Set<string>();
      while (current?.parentId && !seen.has(current.parentId)) {
        if (current.parentId === movingId) forbidden.add(node.id);
        seen.add(current.parentId);
        current = byId.get(current.parentId);
      }
    }
    return contract.nodes
      .filter((node) => node.layout.mode !== "leaf" && node.id !== moving.parentId && !forbidden.has(node.id))
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }, [byId, contract.nodes, movableIds]);
  const effectiveReparentTargetId = reparentOptions.some((node) => node.id === reparentTargetId)
    ? reparentTargetId
    : reparentOptions[0]?.id ?? "";
  const themeStyle = useMemo(() => ({
    "--draft-theme-background": themeColor(contract, "color.background", "#171a20"),
    "--draft-theme-surface": themeColor(contract, "color.surface", "#253047"),
    "--draft-theme-text": themeColor(contract, "color.text", "#e8edf6"),
    "--draft-theme-accent": themeColor(contract, "color.accent", "#5e8cff"),
  } as CSSProperties), [contract]);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const read = () => {
      const next = new Map<string, Bounds>();
      for (const element of surface.querySelectorAll<HTMLElement>("[data-node-id]")) {
        const id = element.dataset.nodeId;
        if (id) next.set(id, { width: element.offsetWidth, height: element.offsetHeight });
      }
      setMeasurements(next);
    };
    read();
    const observer = new ResizeObserver(read);
    for (const element of surface.querySelectorAll<HTMLElement>("[data-node-id]")) observer.observe(element);
    return () => observer.disconnect();
  }, [contract]);

  useEffect(() => {
    const releaseSpace = (event: globalThis.KeyboardEvent) => {
      if (event.key === " ") spacePressedRef.current = false;
    };
    window.addEventListener("keyup", releaseSpace);
    return () => window.removeEventListener("keyup", releaseSpace);
  }, []);

  function canvasPoint(clientX: number, clientY: number): Point {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const safeZoom = zoom > 0 ? zoom : 1;
    return { x: (clientX - (bounds?.left ?? 0)) / safeZoom, y: (clientY - (bounds?.top ?? 0)) / safeZoom };
  }

  function closestNode(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>("[data-node-id]") : null;
  }

  function regionParent(): string {
    const primary = primaryId ? byId.get(primaryId) : undefined;
    if (primary && primary.layout.mode !== "leaf") return primary.id;
    return primary?.parentId && byId.has(primary.parentId) ? primary.parentId : contract.rootNodeId;
  }

  function startInteraction(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    canvasRef.current?.focus({ preventScroll: true });
    const surface = surfaceRef.current;
    const scroll = scrollRef.current;
    if (!surface || !scroll) return;

    if (tool === "pan" || spacePressedRef.current) {
      event.preventDefault();
      surface.setPointerCapture(event.pointerId);
      setInteraction({ kind: "pan", pointerId: event.pointerId, clientOrigin: { x: event.clientX, y: event.clientY }, scrollOrigin: { x: scroll.scrollLeft, y: scroll.scrollTop } });
      return;
    }

    const point = canvasPoint(event.clientX, event.clientY);
    if (tool === "region") {
      event.preventDefault();
      const parentId = regionParent();
      surface.setPointerCapture(event.pointerId);
      setInteraction({ kind: "region", pointerId: event.pointerId, origin: point, parentId, rect: { ...point, width: 0, height: 0 } });
      return;
    }

    const target = event.target instanceof HTMLElement ? event.target : null;
    const resizeEdge = target?.dataset.resizeEdge as ResizeEdge | undefined;
    const resizeNodeId = target?.dataset.resizeNodeId;
    if (resizeEdge && resizeNodeId) {
      event.preventDefault();
      event.stopPropagation();
      if (!selected.has(resizeNodeId)) onSelectionChange([resizeNodeId]);
      surface.setPointerCapture(event.pointerId);
      movedRef.current = false;
      setInteraction({ kind: "resize", pointerId: event.pointerId, origin: point, nodeId: resizeNodeId, edge: resizeEdge, delta: { x: 0, y: 0 } });
      return;
    }

    const nodeElement = closestNode(event.target);
    const nodeId = nodeElement?.dataset.nodeId;
    if (!nodeId) {
      if (!event.ctrlKey && !event.metaKey) onSelectionChange([]);
      return;
    }

    event.preventDefault();
    const toggle = event.ctrlKey || event.metaKey;
    if (toggle) {
      onSelectionChange(selected.has(nodeId) ? selectedIds.filter((id) => id !== nodeId) : [...selectedIds, nodeId]);
      return;
    }

    const nextSelection = selected.has(nodeId) ? selectedIds : [nodeId];
    if (!selected.has(nodeId)) onSelectionChange(nextSelection);
    const dragIds = topLevelSelection(nextSelection, byId).filter((id) => id !== contract.rootNodeId);
    if (dragIds.length === 0) return;
    surface.setPointerCapture(event.pointerId);
    movedRef.current = false;
    setInteraction({ kind: "move", pointerId: event.pointerId, origin: point, nodeIds: dragIds, delta: { x: 0, y: 0 }, dropParentId: null });
  }

  function validDropParent(clientX: number, clientY: number, movingIds: string[]): string | null {
    const moving = new Set(movingIds);
    const forbidden = new Set(movingIds);
    for (const node of contract.nodes) {
      let current: CanvasNode | undefined = node;
      const seen = new Set<string>();
      while (current?.parentId && !seen.has(current.parentId)) {
        if (moving.has(current.parentId)) forbidden.add(node.id);
        seen.add(current.parentId);
        current = byId.get(current.parentId);
      }
    }
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const nodeElement = element.closest<HTMLElement>("[data-node-id]");
      const id = nodeElement?.dataset.nodeId;
      const node = id ? byId.get(id) : undefined;
      if (node && !forbidden.has(node.id) && node.layout.mode !== "leaf") return node.id;
    }
    return null;
  }

  function updateInteraction(event: PointerEvent<HTMLDivElement>) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    if (interaction.kind === "pan") {
      const scroll = scrollRef.current;
      if (!scroll) return;
      scroll.scrollLeft = interaction.scrollOrigin.x - (event.clientX - interaction.clientOrigin.x);
      scroll.scrollTop = interaction.scrollOrigin.y - (event.clientY - interaction.clientOrigin.y);
      return;
    }
    const point = canvasPoint(event.clientX, event.clientY);
    if (interaction.kind === "region") {
      setInteraction({ ...interaction, rect: { x: Math.min(interaction.origin.x, point.x), y: Math.min(interaction.origin.y, point.y), width: Math.abs(point.x - interaction.origin.x), height: Math.abs(point.y - interaction.origin.y) } });
      return;
    }
    const delta = { x: Math.round(point.x - interaction.origin.x), y: Math.round(point.y - interaction.origin.y) };
    if (Math.abs(delta.x) >= DRAG_THRESHOLD || Math.abs(delta.y) >= DRAG_THRESHOLD) movedRef.current = true;
    if (interaction.kind === "resize") {
      setInteraction({ ...interaction, delta });
      return;
    }
    setInteraction({ ...interaction, delta, dropParentId: validDropParent(event.clientX, event.clientY, interaction.nodeIds) });
  }

  function finishInteraction(event: PointerEvent<HTMLDivElement>) {
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    if (surfaceRef.current?.hasPointerCapture(event.pointerId)) surfaceRef.current.releasePointerCapture(event.pointerId);
    if (interaction.kind === "region") {
      const { rect, parentId } = interaction;
      if (rect.width >= 8 && rect.height >= 8) {
        const parentElement = surfaceRef.current?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(parentId)}"]`);
        const surfaceBounds = surfaceRef.current?.getBoundingClientRect();
        const parentBounds = parentElement?.getBoundingClientRect();
        const parentX = parentBounds && surfaceBounds ? (parentBounds.left - surfaceBounds.left) / zoom : 0;
        const parentY = parentBounds && surfaceBounds ? (parentBounds.top - surfaceBounds.top) / zoom : 0;
        onCommand({ type: "create-region", parentId, name: "Region", x: Math.round(rect.x - parentX), y: Math.round(rect.y - parentY), width: Math.round(rect.width), height: Math.round(rect.height) });
      }
    } else if (interaction.kind === "resize" && movedRef.current) {
      onCommand({ type: "resize-node", nodeId: interaction.nodeId, edge: interaction.edge, deltaX: interaction.delta.x, deltaY: interaction.delta.y });
    } else if (interaction.kind === "move" && movedRef.current) {
      const changedParent = interaction.dropParentId && interaction.nodeIds.some((id) => byId.get(id)?.parentId !== interaction.dropParentId);
      if (interaction.dropParentId && changedParent) {
        const existingChildren = contract.nodes.filter((node) => node.parentId === interaction.dropParentId && !interaction.nodeIds.includes(node.id));
        interaction.nodeIds.forEach((nodeId, index) => onCommand({ type: "reparent-node", nodeId, parentId: interaction.dropParentId!, order: existingChildren.length + index }));
      } else if (interaction.delta.x || interaction.delta.y) {
        interaction.nodeIds.forEach((nodeId) => onCommand({ type: "move-node", nodeId, deltaX: interaction.delta.x, deltaY: interaction.delta.y }));
      }
    }
    setInteraction(null);
    movedRef.current = false;
  }

  function cancelInteraction(event: PointerEvent<HTMLDivElement>) {
    if (interaction && event.pointerId === interaction.pointerId) {
      setInteraction(null);
      movedRef.current = false;
    }
  }

  function deleteSelection() {
    const deletable = topLevelSelection(selectedIds, byId).filter((id) => id !== contract.rootNodeId);
    deletable.forEach((nodeId) => onCommand({ type: "delete-node", nodeId }));
    if (deletable.length > 0) {
      const removed = new Set(deletable);
      for (const node of contract.nodes) {
        let current: CanvasNode | undefined = node;
        const seen = new Set<string>();
        while (current?.parentId && !seen.has(current.parentId)) {
          if (removed.has(current.parentId)) removed.add(node.id);
          seen.add(current.parentId);
          current = byId.get(current.parentId);
        }
      }
      onSelectionChange(selectedIds.filter((id) => !removed.has(id)));
    }
  }

  function groupSelection() {
    if (groupableIds.length >= 2) onCommand({ type: "group-selected", nodeIds: groupableIds });
  }

  function ungroupSelection() {
    if (ungroupableIds.length > 0) onCommand({ type: "ungroup-selected", nodeIds: ungroupableIds });
  }

  function alignSelection() {
    if (arrangeableIds.length >= 2) onCommand({ type: "align-selected", nodeIds: arrangeableIds, alignment });
  }

  function distributeSelection() {
    if (arrangeableIds.length >= 3) onCommand({ type: "distribute-selected", nodeIds: arrangeableIds, axis: distributionAxis });
  }

  function reparentSelection() {
    if (movableIds.length !== 1 || !effectiveReparentTargetId) return;
    const order = contract.nodes.filter((node) => node.parentId === effectiveReparentTargetId).length;
    onCommand({ type: "reparent-node", nodeId: movableIds[0]!, parentId: effectiveReparentTargetId, order });
  }

  function keyDown(event: KeyboardEvent<HTMLElement>) {
    if (composingRef.current || event.nativeEvent.isComposing || isEditableTarget(event.target)) return;
    if (event.key === " ") {
      spacePressedRef.current = true;
      event.preventDefault();
      return;
    }
    if ((event.key === "Delete" || event.key === "Backspace") && movableIds.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      deleteSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      event.stopPropagation();
      ungroupSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "g") {
      event.preventDefault();
      event.stopPropagation();
      groupSelection();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d" && movableIds.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      movableIds.forEach((nodeId) => onCommand({ type: "duplicate-node", nodeId }));
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setInteraction(null);
      onSelectionChange([]);
      return;
    }
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key) && movableIds.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      const amount = event.shiftKey ? 8 : 1;
      const deltaX = event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0;
      const deltaY = event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0;
      movableIds.forEach((nodeId) => onCommand({ type: "move-node", nodeId, deltaX, deltaY }));
    }
  }

  function keyUp(event: KeyboardEvent<HTMLElement>) {
    if (event.key === " ") spacePressedRef.current = false;
  }

  function wheel(event: WheelEvent<HTMLDivElement>) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    onZoom(clampZoom(zoom * Math.exp(-event.deltaY * 0.002)));
  }

  if (!root) return <div className="canvas-failure" role="alert">The contract root node is missing.</div>;
  return (
    <section
      ref={canvasRef}
      className="draft-canvas-area"
      aria-label="Layout draft canvas"
      tabIndex={0}
      data-testid="draft-canvas"
      data-theme-id={contract.designSystem.id}
      data-theme-revision={contract.designSystem.revision}
      style={themeStyle}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onCompositionStartCapture={() => { composingRef.current = true; }}
      onCompositionEndCapture={() => { composingRef.current = false; }}
    >
      <div className="draft-canvas-controls">
        <span>{CANVAS_WIDTH} × {CANVAS_HEIGHT} CSS px</span>
        <span className="draft-selection-count" aria-live="polite">{selected.size === 0 ? "No selection" : `${selected.size} selected`}</span>
        <button data-testid="group-selection" type="button" disabled={groupableIds.length < 2} onClick={groupSelection}>Group <kbd>Ctrl G</kbd></button>
        <button data-testid="delete-selection" type="button" disabled={movableIds.length === 0} onClick={deleteSelection}>Delete</button>
        <label>Zoom <input aria-label="Canvas zoom" type="range" min="20" max="150" value={Math.round(zoom * 100)} onChange={(event) => onZoom(Number(event.target.value) / 100)} /></label>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <div className="draft-canvas-actions" role="group" aria-label="Arrange and structure selection">
        <label>
          <span>Align</span>
          <select data-testid="align-mode" aria-label="Alignment" value={alignment} onChange={(event) => setAlignment(event.target.value as Alignment)}>
            <option value="left">Left</option><option value="center-x">Horizontal center</option><option value="right">Right</option>
            <option value="top">Top</option><option value="center-y">Vertical center</option><option value="bottom">Bottom</option>
          </select>
        </label>
        <button data-testid="align-selection" type="button" disabled={arrangeableIds.length < 2} onClick={alignSelection}>Apply</button>
        <label>
          <span>Distribute</span>
          <select data-testid="distribute-axis" aria-label="Distribution axis" value={distributionAxis} onChange={(event) => setDistributionAxis(event.target.value as DistributionAxis)}>
            <option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
          </select>
        </label>
        <button data-testid="distribute-selection" type="button" disabled={arrangeableIds.length < 3} onClick={distributeSelection}>Apply</button>
        <button data-testid="ungroup-selection" type="button" disabled={ungroupableIds.length === 0} onClick={ungroupSelection}>Ungroup <kbd>Ctrl Shift G</kbd></button>
        <label className="draft-reparent-control">
          <span>Parent</span>
          <select data-testid="reparent-target" aria-label="New parent" value={effectiveReparentTargetId} disabled={reparentOptions.length === 0} onChange={(event) => setReparentTargetId(event.target.value)}>
            {reparentOptions.length === 0 ? <option value="">No eligible container</option> : reparentOptions.map((node) => <option key={node.id} value={node.id}>{node.name} · {node.id}</option>)}
          </select>
        </label>
        <button data-testid="reparent-selection" type="button" disabled={!effectiveReparentTargetId} onClick={reparentSelection}>Move</button>
        <span className="draft-action-status" role="status">
          {movableIds.length >= 2 && arrangeableIds.length === 0 ? "Arrange requires same-parent fixed anchor boxes." : ""}
        </span>
      </div>
      <div ref={scrollRef} className={`draft-canvas-scroll tool-${tool}`} onWheel={wheel}>
        <div
          ref={surfaceRef}
          className="draft-canvas-surface"
          data-testid="draft-canvas-surface"
          data-theme-id={contract.designSystem.id}
          data-theme-revision={contract.designSystem.revision}
          style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, transform: `scale(${zoom})`, "--draft-inverse-zoom": 1 / Math.max(zoom, 0.01) } as CSSProperties}
          onPointerDown={startInteraction}
          onPointerMove={updateInteraction}
          onPointerUp={finishInteraction}
          onPointerCancel={cancelInteraction}
        >
          <NodeView node={root} nodes={contract.nodes} rootId={contract.rootNodeId} selected={selected} primaryId={primaryId} interaction={interaction} measurements={measurements} />
          {interaction?.kind === "region" && <div className="draft-region" style={{ left: interaction.rect.x, top: interaction.rect.y, width: interaction.rect.width, height: interaction.rect.height }} />}
          {review?.spatial.map((delta) => delta.after && (
            <div key={delta.nodeId} className={`draft-diff-outline ${delta.violation ? "has-violation" : ""}`} style={{ left: delta.after.x, top: delta.after.y, width: delta.after.width, height: delta.after.height }}>
              <span>{delta.nodeId}{delta.violation ? ` · ${delta.violation}` : ""}</span>
              {delta.before && <svg className="draft-diff-vector"><line x1={delta.before.x - delta.after.x} y1={delta.before.y - delta.after.y} x2="0" y2="0" /></svg>}
            </div>
          ))}
        </div>
      </div>
      <div className="draft-canvas-hint">Drag boxes to move. Drop on a container to change parent. Ctrl-click selects more boxes.</div>
    </section>
  );
}
