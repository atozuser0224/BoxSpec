import { useEffect, useRef, useState, type CompositionEvent, type KeyboardEvent } from "react";
import type { CanvasNode, EditorCommand } from "../../common/ipc";
import { EmptyState } from "./Status";

export function Inspector({ node, onCommand }: { node: CanvasNode | null; onCommand(command: EditorCommand): void }) {
  const [name, setName] = useState(node?.name ?? "");
  const [composing, setComposing] = useState(false);
  const cancelName = useRef(false);
  useEffect(() => setName(node?.name ?? ""), [node]);
  if (!node) return <aside className="inspector"><EmptyState title="No selection" detail="Select a region on the canvas or in Layers." /></aside>;
  const selectedNode = node;

  function commitName() {
    if (cancelName.current) { cancelName.current = false; return; }
    if (name.trim() && name !== selectedNode.name) onCommand({ type: "rename-node", nodeId: selectedNode.id, name: name.trim() });
  }
  function nameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !composing && !event.nativeEvent.isComposing) { event.currentTarget.blur(); }
    if (event.key === "Escape") { cancelName.current = true; setName(selectedNode.name); event.currentTarget.blur(); }
  }
  const endComposition = (_event: CompositionEvent<HTMLInputElement>) => setComposing(false);
  const fixedValue = selectedNode.layout.width.mode === "fixed" ? selectedNode.layout.width.value ?? 100 : 100;
  const policyPath = selectedNode.layout.width.mode === "fixed" ? "/layout/width/value" : "/layout/gap";
  const policyValue = selectedNode.layout.width.mode === "fixed" ? fixedValue : selectedNode.layout.gap;
  const layoutLock = selectedNode.locks.find((lock) => policyPath === lock.path || policyPath.startsWith(`${lock.path}/`) || lock.path.startsWith(`${policyPath}/`));

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="panel-heading"><strong>Inspector</strong><span>{node.id}</span></div>
      <fieldset><legend>Identity</legend>
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={nameKeyDown} onCompositionStart={() => setComposing(true)} onCompositionEnd={endComposition} /></label>
        <label>Role<input value={node.role} readOnly /></label>
      </fieldset>
      <fieldset><legend>Layout</legend>
        <label>Mode<select value={node.layout.mode} onChange={(e) => onCommand({ type: "set-layout", nodeId: node.id, mode: e.target.value as CanvasNode["layout"]["mode"] })}>
          {(["row", "column", "grid", "overlay", "leaf"] as const).map((mode) => <option key={mode}>{mode}</option>)}
        </select></label>
        <SizeEditor label="Width" axis="width" node={node} onCommand={onCommand} />
        <SizeEditor label="Height" axis="height" node={node} onCommand={onCommand} />
      </fieldset>
      <fieldset><legend>Agent policy</legend>
        <label>Layout lock<select data-testid="layout-policy" value={layoutLock?.policy ?? "free"} onChange={(e) => { const policy = e.target.value as "hard" | "soft" | "free"; onCommand({ type: "set-policy", nodeId: node.id, path: policyPath, policy, ...(policy === "soft" ? { min: Math.max(0, policyValue - 20), max: policyValue + 20 } : {}) }); }}>
          <option value="hard">Hard — immutable</option><option value="soft">Soft — constrained</option><option value="free">Free — editable</option>
        </select></label>
        {layoutLock?.policy === "soft" && <div className="soft-range"><label>Minimum<input data-testid="soft-min" type="number" min="0" value={layoutLock.min ?? Math.max(0, policyValue - 20)} onChange={(event) => onCommand({ type: "set-policy", nodeId: node.id, path: policyPath, policy: "soft", min: Number(event.target.value), max: layoutLock.max ?? policyValue + 20 })} /></label><label>Maximum<input data-testid="soft-max" type="number" min={layoutLock.min ?? 0} value={layoutLock.max ?? policyValue + 20} onChange={(event) => onCommand({ type: "set-policy", nodeId: node.id, path: policyPath, policy: "soft", min: layoutLock.min ?? Math.max(0, policyValue - 20), max: Number(event.target.value) })} /></label></div>}
        <p className="help">Hard changes require a separate contract proposal and user approval.</p>
      </fieldset>
      <fieldset><legend>Placement</legend>
        <div className="button-row"><button type="button" onClick={() => onCommand({ type: "duplicate-node", nodeId: node.id })}>Duplicate</button><button className="danger" type="button" onClick={() => onCommand({ type: "delete-node", nodeId: node.id })}>Delete</button></div>
      </fieldset>
    </aside>
  );
}

function SizeEditor({ label, axis, node, onCommand }: { label: string; axis: "width" | "height"; node: CanvasNode; onCommand(command: EditorCommand): void }) {
  const rule = node.layout[axis];
  return <div className="size-editor"><span>{label}</span><select aria-label={`${label} mode`} value={rule.mode} onChange={(e) => onCommand({ type: "set-size", nodeId: node.id, axis, rule: e.target.value === "fixed" ? { mode: "fixed", value: rule.value ?? 100 } : e.target.value === "fill" ? { mode: "fill", weight: 1, min: 0 } : { mode: "hug", min: 0 } })}><option value="fixed">Fixed</option><option value="fill">Fill</option><option value="hug">Hug</option></select>{rule.mode === "fixed" && <input data-testid={`${axis}-value`} aria-label={`${label} value`} type="number" min="0" value={rule.value ?? 0} onChange={(e) => onCommand({ type: "set-size", nodeId: node.id, axis, rule: { mode: "fixed", value: Number(e.target.value) } })} />}</div>;
}
