import { useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import type { CanvasNode, EditorCommand, EditorScreen, ReviewDetail } from "../../common/ipc";

interface CanvasProps {
  screen: EditorScreen;
  selectedId: string | null;
  tool: "select" | "region" | "pan";
  zoom: number;
  review: ReviewDetail | null;
  onSelect(nodeId: string): void;
  onCommand(command: EditorCommand): void;
  onZoom(zoom: number): void;
}

function nodeSizing(node: CanvasNode, parentMode?: CanvasNode["layout"]["mode"]): CSSProperties {
  const main = parentMode === "row" ? node.layout.width : node.layout.height;
  const flex = main.mode === "fixed" ? `0 0 ${main.value ?? 0}px` : main.mode === "fill" ? `${main.weight ?? 1} 1 ${main.min ?? 0}px` : "0 1 auto";
  return {
    flex: parentMode === "row" || parentMode === "column" ? flex : undefined,
    width: node.layout.width.mode === "fixed" ? node.layout.width.value : parentMode !== "row" && node.layout.width.mode === "fill" ? "100%" : undefined,
    height: node.layout.height.mode === "fixed" ? node.layout.height.value : parentMode !== "column" && node.layout.height.mode === "fill" ? "100%" : undefined,
    minWidth: node.layout.width.min,
    minHeight: node.layout.height.min,
    maxWidth: node.layout.width.max,
    maxHeight: node.layout.height.max,
  };
}

function NodeView({ node, nodes, selectedId, parentMode, onSelect }: { node: CanvasNode; nodes: CanvasNode[]; selectedId: string | null; parentMode?: CanvasNode["layout"]["mode"]; onSelect(id: string): void }) {
  const children = nodes.filter((entry) => entry.parentId === node.id).sort((a, b) => a.order - b.order);
  const layout: CSSProperties = {
    ...nodeSizing(node, parentMode),
    display: node.visible === false ? "none" : node.layout.mode === "grid" ? "grid" : "flex",
    flexDirection: node.layout.mode === "row" ? "row" : "column",
    gridTemplateColumns: node.layout.mode === "grid" ? `repeat(${node.layout.gridColumns ?? 2}, minmax(0, 1fr))` : undefined,
    gap: node.layout.gap,
    padding: `${node.layout.padding.top}px ${node.layout.padding.right}px ${node.layout.padding.bottom}px ${node.layout.padding.left}px`,
    alignItems: node.layout.align === "start" ? "flex-start" : node.layout.align === "end" ? "flex-end" : node.layout.align,
    justifyContent: node.layout.justify === "start" ? "flex-start" : node.layout.justify === "end" ? "flex-end" : node.layout.justify,
  };
  const hard = node.locks.some((lock) => lock.policy === "hard");
  return (
    <div
      className={`canvas-node ${selectedId === node.id ? "is-selected" : ""} ${children.length === 0 ? "is-leaf" : ""}`}
      style={layout}
      data-node-id={node.id}
      onPointerDown={(event) => { event.stopPropagation(); onSelect(node.id); }}
    >
      <span className="node-label">{node.name}<small>{hard ? "Hard" : node.role}</small></span>
      {children.map((child) => <NodeView key={child.id} node={child} nodes={nodes} selectedId={selectedId} parentMode={node.layout.mode} onSelect={onSelect} />)}
    </div>
  );
}

export function Canvas({ screen, selectedId, tool, zoom, review, onSelect, onCommand, onZoom }: CanvasProps) {
  const root = useMemo(() => screen.nodes.find((node) => node.id === screen.rootNodeId), [screen]);
  const surface = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  function canvasPoint(event: PointerEvent): { x: number; y: number } {
    const bounds = surface.current?.getBoundingClientRect();
    return { x: (event.clientX - (bounds?.left ?? 0)) / zoom, y: (event.clientY - (bounds?.top ?? 0)) / zoom };
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (tool !== "region" || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    origin.current = canvasPoint(event);
    setDraft({ ...origin.current, width: 0, height: 0 });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!origin.current || tool !== "region") return;
    const point = canvasPoint(event);
    setDraft({
      x: Math.min(origin.current.x, point.x),
      y: Math.min(origin.current.y, point.y),
      width: Math.abs(point.x - origin.current.x),
      height: Math.abs(point.y - origin.current.y),
    });
  }

  function pointerUp() {
    if (draft && draft.width >= 8 && draft.height >= 8) {
      onCommand({ type: "create-region", parentId: selectedId ?? screen.rootNodeId, name: "Region", ...draft });
    }
    origin.current = null;
    setDraft(null);
  }

  if (!root) return <div className="canvas-failure" role="alert">The contract root node is missing.</div>;
  return (
    <section className="canvas-area" aria-label="Layout canvas">
      <div className="canvas-controls">
        <span>1440 × 900 CSS px</span>
        <label>Zoom <input aria-label="Canvas zoom" type="range" min="25" max="125" value={Math.round(zoom * 100)} onChange={(e) => onZoom(Number(e.target.value) / 100)} /></label>
        <span>{Math.round(zoom * 100)}%</span>
      </div>
      <div className={`canvas-scroll tool-${tool}`}>
        <div
          ref={surface}
          className="canvas-viewport"
          style={{ width: 1440, height: 900, transform: `scale(${zoom})` }}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
        >
          <NodeView node={root} nodes={screen.nodes} selectedId={selectedId} onSelect={onSelect} />
          {draft && <div className="draft-region" style={{ left: draft.x, top: draft.y, width: draft.width, height: draft.height }} />}
          {review?.spatial.map((delta) => delta.after && (
            <div key={delta.nodeId} className={`diff-outline ${delta.violation ? "has-violation" : ""}`} style={{ left: delta.after.x, top: delta.after.y, width: delta.after.width, height: delta.after.height }}>
              <span>{delta.nodeId}{delta.violation ? ` · ${delta.violation}` : ""}</span>
              {delta.before && <svg className="diff-vector"><line x1={delta.before.x - delta.after.x} y1={delta.before.y - delta.after.y} x2="0" y2="0" /></svg>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
