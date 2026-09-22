import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BootstrapData, ClientStatus, DesktopResult, EditorCommand, EditorScreen, LayoutDraftState, LayoutDraftSummary, LayoutHandoff, ProjectSummary, RecoveryInspection, ReviewDetail, ReviewSummary, RuntimeCapabilities, ScreenSummary, ThemeGalleryItem } from "../common/ipc";
import { ClientWizard } from "./components/ClientWizard";
import { DraftCanvas } from "./components/DraftCanvas";
import { Inspector } from "./components/Inspector";
import { ReviewPanel } from "./components/ReviewPanel";
import { EmptyState, ErrorBanner, StatusBadge } from "./components/Status";
import { ThemeGallery } from "./components/ThemeGallery";
import { WorkspacePanels } from "./components/WorkspacePanels";

const noCapabilities: RuntimeCapabilities = { editor: false, review: false, apply: false, recovery: false, drift: false, clients: false, verifier: false };

export function App() {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [screens, setScreens] = useState<ScreenSummary[]>([]);
  const [screen, setScreen] = useState<EditorScreen | null>(null);
  const [layoutDraft, setLayoutDraft] = useState<LayoutDraftState | null>(null);
  const [queuedDraft, setQueuedDraft] = useState<LayoutDraftSummary | null>(null);
  const [handoff, setHandoff] = useState<LayoutHandoff | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [tool, setTool] = useState<"select" | "region" | "pan">("select");
  const [zoom, setZoom] = useState(0.62);
  const [rightTab, setRightTab] = useState<"inspect" | "review">("inspect");
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [clients, setClients] = useState<ClientStatus[]>([]);
  const [drift, setDrift] = useState<Array<{ driftId: string; projectId: string; paths: string[]; detectedTreeHash: string }>>([]);
  const [recovery, setRecovery] = useState<RecoveryInspection | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [themeOpen, setThemeOpen] = useState(false);
  const [themes, setThemes] = useState<ThemeGalleryItem[]>([]);
  const [themeApplying, setThemeApplying] = useState(false);
  const [themeError, setThemeError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [jobsOpen, setJobsOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<DesktopResult<unknown> | null>(null);
  const composing = useRef(false);
  const screenRef = useRef<EditorScreen | null>(null);
  const draftRef = useRef<LayoutDraftState | null>(null);
  const commandQueue = useRef<Promise<void>>(Promise.resolve());
  const capabilities = boot?.capabilities ?? noCapabilities;
  const selectedId = selectedIds[selectedIds.length - 1] ?? null;
  const setSelectedId = useCallback((nodeId: string | null) => setSelectedIds(nodeId ? [nodeId] : []), []);
  const selectedNode = screen?.nodes.find((node) => node.id === selectedId) ?? null;
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { draftRef.current = layoutDraft; }, [layoutDraft]);

  const reportError = useCallback((result: DesktopResult<unknown>) => { if (!result.ok) setError(result); }, []);
  useEffect(() => { void window.boxspec.bootstrap().then((result) => result.ok ? setBoot(result.data) : reportError(result)); }, [reportError]);

  const refreshReviews = useCallback(async (projectId: string) => {
    const result = await window.boxspec.listReviews({ projectId });
    if (result.ok) setReviews([...result.data]); else if (result.error.code !== "CAPABILITY_UNAVAILABLE") reportError(result);
  }, [reportError]);
  const refreshClients = useCallback(async () => {
    if (!project) return;
    const result = await window.boxspec.clientStatus({ projectId: project.projectId });
    if (result.ok) setClients([...result.data]); else reportError(result);
  }, [project, reportError]);
  const refreshDrift = useCallback(async () => {
    if (!project) return;
    const result = await window.boxspec.inspectDrift({ projectId: project.projectId });
    if (result.ok) setDrift([...result.data]); else reportError(result);
  }, [project, reportError]);
  const checkLayoutDrafts = useCallback(async (projectId: string, screenId?: string) => {
    const result = await window.boxspec.listLayoutDrafts({ projectId });
    if (!result.ok) { if (result.error.code !== "CAPABILITY_UNAVAILABLE") reportError(result); return; }
    const latest = [...result.data].filter((entry) => (!screenId || entry.screenId === screenId) && (entry.status === "AWAITING_USER" || entry.status === "USER_EDITING_DRAFT")).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!latest || latest.proposalId === layoutDraft?.summary.proposalId) return;
    if (dirty || layoutDraft) { setQueuedDraft(latest); return; }
    const opened = await window.boxspec.openLayoutDraft({ projectId, proposalId: latest.proposalId });
    if (!opened.ok) return reportError(opened);
    setLayoutDraft(opened.data); setScreen(opened.data.contract); setSelectedId(opened.data.selectedNodeIds[0] ?? opened.data.contract.rootNodeId); setDirty(false); setQueuedDraft(null); setHandoff(null);
  }, [dirty, layoutDraft, reportError]);

  useEffect(() => {
    if (!project) return;
    void checkLayoutDrafts(project.projectId, screen?.screenId);
    const timer = window.setInterval(() => { void checkLayoutDrafts(project.projectId, screen?.screenId); }, 5000);
    return () => window.clearInterval(timer);
  }, [project, screen?.screenId, checkLayoutDrafts]);

  async function openProject(projectId: string) {
    setBusy(true); const result = await window.boxspec.openProject({ projectId }); setBusy(false);
    if (!result.ok) return reportError(result);
    setProject(result.data.project); setScreens([...result.data.screens]); setScreen(null); setSelectedId(null); setReview(null); setLayoutDraft(null); setQueuedDraft(null); setDirty(false);
    void refreshReviews(projectId);
    void checkLayoutDrafts(projectId);
  }
  async function openScreen(screenId: string) {
    if (!project) return; setBusy(true); const result = await window.boxspec.openScreen({ projectId: project.projectId, screenId }); setBusy(false);
    if (!result.ok) return reportError(result); setScreen(result.data); setSelectedId(result.data.rootNodeId); setDirty(false); setLayoutDraft(null); setHandoff(null);
    void checkLayoutDrafts(project.projectId, screenId);
  }
  async function createScreen() {
    if (!project) return; const name = `Screen ${screens.length + 1}`; setBusy(true); const result = await window.boxspec.createScreen({ projectId: project.projectId, name }); setBusy(false);
    if (!result.ok) return reportError(result); setScreen(result.data); setScreens((current) => [...current, { screenId: result.data.screenId, name: result.data.name, revision: result.data.revision }]); setSelectedId(result.data.rootNodeId); setDirty(false);
  }
  const command = useCallback((next: EditorCommand): Promise<void> => {
    const pending = commandQueue.current.then(async () => {
      const currentScreen = screenRef.current;
      const currentDraft = draftRef.current;
      if (!currentScreen) return;
      const contract = applyEditorCommand(currentScreen, next, currentDraft ? currentDraft.summary.baseRevision + 1 : currentScreen.revision + 1);
      if (!contract) return;
      if (currentDraft) {
        const result = await window.boxspec.updateLayoutDraft({ projectId: currentScreen.projectId, proposalId: currentDraft.summary.proposalId, expectedDraftRevision: currentDraft.summary.draftRevision, contract });
        if (!result.ok) { reportError(result); return; }
        draftRef.current = result.data; screenRef.current = result.data.contract; setLayoutDraft(result.data); setScreen(result.data.contract); setDirty(true); return;
      }
      const result = await window.boxspec.executeCommand({ projectId: currentScreen.projectId, screenId: currentScreen.screenId, expectedRevision: currentScreen.revision, command: { type: "replace-contract", contract } });
      if (!result.ok) { reportError(result); return; }
      screenRef.current = result.data; setScreen(result.data); setDirty(true);
    });
    commandQueue.current = pending.catch(() => undefined);
    return pending;
  }, [reportError]);
  const save = useCallback(async () => {
    if (!screen || layoutDraft) return; setBusy(true); setExporting(true); const result = await window.boxspec.saveScreen({ projectId: screen.projectId, screenId: screen.screenId, expectedRevision: screen.revision }); setBusy(false); setExporting(false);
    if (!result.ok) return reportError(result); setScreen(result.data); setDirty(false);
  }, [screen, layoutDraft, reportError]);
  const history = useCallback(async (direction: "undo" | "redo") => {
    if (!screen) return; const result = await window.boxspec[direction]({ projectId: screen.projectId, screenId: screen.screenId, expectedRevision: screen.revision });
    if (!result.ok) return reportError(result); setScreen(result.data); setDirty(true);
  }, [screen, reportError]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (composing.current || event.isComposing || target?.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.ctrlKey && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); return; }
      if (event.ctrlKey && event.key.toLowerCase() === "z") { event.preventDefault(); void history(event.shiftKey ? "redo" : "undo"); return; }
      if (event.ctrlKey && event.key.toLowerCase() === "y") { event.preventDefault(); void history("redo"); return; }
      if (event.ctrlKey && event.key.toLowerCase() === "d" && selectedId) { event.preventDefault(); void command({ type: "duplicate-node", nodeId: selectedId }); return; }
      if (event.key.toLowerCase() === "r") setTool("region");
      if (event.key.toLowerCase() === "v") setTool("select");
      if (event.key.toLowerCase() === "f") setZoom(0.62);
      if (selectedId && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); const amount = event.shiftKey ? 8 : 1; void command({ type: "move-node", nodeId: selectedId, deltaX: event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0, deltaY: event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0 }); }
    };
    const start = () => { composing.current = true; }; const end = () => { composing.current = false; };
    window.addEventListener("keydown", listener); window.addEventListener("compositionstart", start); window.addEventListener("compositionend", end);
    return () => { window.removeEventListener("keydown", listener); window.removeEventListener("compositionstart", start); window.removeEventListener("compositionend", end); };
  }, [command, history, save, selectedId]);

  async function openReview(candidateId: string) { if (!project) return; setBusy(true); const result = await window.boxspec.openReview({ projectId: project.projectId, candidateId }); setBusy(false); if (!result.ok) return reportError(result); setReview(result.data); setRightTab("review"); }
  async function approve() { if (!project || !review) return; setBusy(true); const result = await window.boxspec.approveAndApply({ projectId: project.projectId, candidateId: review.candidateId, reportId: review.reportId, reviewNonce: review.reviewNonce }); setBusy(false); if (!result.ok) return reportError(result); setReview(null); await refreshReviews(project.projectId); }
  async function publishDraft() { if (!project || !layoutDraft) return; setBusy(true); const result = await window.boxspec.publishLayoutDraft({ projectId: project.projectId, proposalId: layoutDraft.summary.proposalId, expectedDraftRevision: layoutDraft.summary.draftRevision, expectedBaseRevision: layoutDraft.summary.baseRevision, expectedBaseHash: layoutDraft.summary.baseContractHash }); setBusy(false); if (!result.ok) return reportError(result); setHandoff(result.data.handoff); screenRef.current = result.data.editor; draftRef.current = null; setScreen(result.data.editor); setLayoutDraft(null); setQueuedDraft(null); setDirty(false); }
  async function openThemes() {
    if (!project || !screen) return;
    setThemeOpen(true); setThemeError(null);
    const result = await window.boxspec.listThemes({ projectId: project.projectId });
    if (!result.ok) { setThemeError(result.error.message); reportError(result); return; }
    setThemes([...result.data]);
  }
  async function applyTheme(themeId: string) {
    const currentScreen = screenRef.current;
    const currentDraft = draftRef.current;
    if (!project || !currentScreen) return;
    setThemeApplying(true); setThemeError(null);
    const result = currentDraft
      ? await window.boxspec.applyThemeToDraft({ projectId: project.projectId, proposalId: currentDraft.summary.proposalId, themeId, expectedDraftRevision: currentDraft.summary.draftRevision })
      : await window.boxspec.applyThemeToScreen({ projectId: project.projectId, screenId: currentScreen.screenId, themeId, expectedRevision: currentScreen.revision });
    setThemeApplying(false);
    if (!result.ok) { setThemeError(result.error.message); reportError(result); return; }
    if (currentDraft) {
      const updated = result.data as LayoutDraftState;
      draftRef.current = updated; screenRef.current = updated.contract; setLayoutDraft(updated); setScreen(updated.contract);
    } else {
      const updated = result.data as EditorScreen;
      screenRef.current = updated; setScreen(updated);
    }
    setDirty(true);
  }
  async function openThemeSource(sourceUrl: string) {
    if (!project) return;
    const theme = themes.find((item) => item.source.url === sourceUrl);
    if (!theme) { setThemeError("Theme source is not in the trusted catalog."); return; }
    const result = await window.boxspec.openThemeSource({ projectId: project.projectId, themeId: theme.id });
    if (!result.ok) { setThemeError(result.error.message); reportError(result); }
  }
  const layerTree = useMemo(() => screen?.nodes.slice().sort((a, b) => a.order - b.order) ?? [], [screen]);

  if (!boot) return <main className="loading"><strong>Starting BoxSpec…</strong><span>Opening the local runtime</span></main>;
  if (!project) return <Welcome boot={boot} busy={busy} createOpen={createOpen} setCreateOpen={setCreateOpen} onOpen={openProject} onCreated={(created, createdScreens) => { setProject(created); setScreens(createdScreens); setCreateOpen(false); }} onError={reportError} error={error} clearError={() => setError(null)} />;
  return (
    <main className="app-shell">
      <ErrorBanner result={error} onDismiss={() => setError(null)} />
      <header className="toolbar"><button type="button" className="project-switcher" onClick={() => { setProject(null); setScreen(null); }}>{project.name}<small>{screen?.name ?? "Choose a screen"}</small></button><div className="tool-group" role="group" aria-label="Canvas tools"><button className={tool === "select" ? "active" : ""} onClick={() => setTool("select")} title="Select (V)">Select <kbd>V</kbd></button><button className={tool === "region" ? "active" : ""} onClick={() => setTool("region")} title="Draw region (R)">Region <kbd>R</kbd></button></div><div className="toolbar-spacer" />{layoutDraft ? <span data-testid="active-draft-status" className="status status-unverified">AI DRAFT r{layoutDraft.summary.draftRevision}</span> : <span data-testid="persistence-status" className={`status ${dirty || exporting ? "status-unverified" : "status-pass"}`}>{exporting ? "LOCAL SAVED · EXPORTING" : dirty ? "LOCAL SAVED · SOURCE PENDING" : "SOURCE SYNCED"}</span>}<span className="revision">Revision {screen?.revision ?? "—"}</span><button data-testid="save-screen" type="button" onClick={() => void save()} disabled={!screen || busy || Boolean(layoutDraft)}>Save <kbd>Ctrl S</kbd></button>{layoutDraft && <button data-testid="implement-layout" type="button" className="primary" disabled={busy} onClick={() => void publishDraft()}>이 배치로 구현</button>}<button data-testid="theme-gallery-open" type="button" onClick={() => void openThemes()} disabled={!screen}>디자인 테마</button><button data-testid="clients-open" type="button" onClick={() => { setWizardOpen(true); void refreshClients(); }}>Clients</button><button data-testid="review-open" type="button" className="primary" onClick={() => { setRightTab("review"); void refreshReviews(project.projectId); }}>Review {reviews.length > 0 && <b>{reviews.length}</b>}</button></header>
      {queuedDraft && <div data-testid="queued-draft-banner" className="draft-banner" role="status"><strong>New AI layout draft available</strong><span>{queuedDraft.reason}. Your current edits were kept; the new draft is queued.</span></div>}
      {handoff && <div data-testid="handoff-banner" className="handoff-banner" role="status"><strong>Layout sent for implementation</strong><span data-testid="handoff-revision">Revision {handoff.newRevision} · {handoff.affectedNodeIds.length} affected nodes · {handoff.status}</span><code data-testid="handoff-id">{handoff.handoffId}</code><button onClick={() => setHandoff(null)}>Dismiss</button></div>}
      <WorkspacePanels
        left={<aside className="left-panel"><div className="panel-tabs"><button className="active">Screens</button><button>Layers</button><button>Assets</button></div><div className="screen-list">{screens.map((item) => <button type="button" key={item.screenId} data-testid={`screen-${item.screenId}`} className={screen?.screenId === item.screenId ? "active" : ""} onClick={() => void openScreen(item.screenId)}><span>{item.name}</span><small>r{item.revision}</small></button>)}<button data-testid="new-screen" type="button" className="add-screen" onClick={() => void createScreen()}>+ New screen</button></div>{screen && <div className="layers"><div className="section-title">Layers</div>{layerTree.map((node) => <button type="button" data-testid={`layer-${node.id}`} className={node.id === selectedId ? "active" : ""} key={node.id} style={{ paddingLeft: `${12 + Math.max(0, parentDepth(node.id, screen.nodes)) * 14}px` }} onClick={() => setSelectedId(node.id)}><span>{node.name}</span><small>{node.locks.some((lock) => lock.policy === "hard") ? "Hard" : node.role}</small></button>)}</div>}</aside>}
        canvas={screen ? <DraftCanvas contract={screen} selectedIds={selectedIds} tool={tool} zoom={zoom} review={review} onSelectionChange={setSelectedIds} onCommand={(next) => void command(next)} onZoom={setZoom} /> : <section className="no-screen"><EmptyState title="Waiting for a layout draft" detail="An agent draft appears directly on this canvas. You can also create a screen manually." /><button type="button" className="primary" onClick={() => void createScreen()}>Create screen manually</button></section>}
        right={<div className="right-area"><div className="right-tabs"><button className={rightTab === "inspect" ? "active" : ""} onClick={() => setRightTab("inspect")}>Inspect</button><button className={rightTab === "review" ? "active" : ""} onClick={() => setRightTab("review")}>Review {reviews.length > 0 && <span>{reviews.length}</span>}</button></div>{rightTab === "inspect" ? <Inspector node={selectedNode} onCommand={(next) => void command(next)} /> : <ReviewPanel reviews={reviews} detail={review} capabilities={capabilities} busy={busy} onOpen={(id) => void openReview(id)} onApprove={() => void approve()} />}</div>}
      />
      <section className={`jobs ${jobsOpen ? "open" : ""}`}><button data-testid="jobs-open" type="button" className="jobs-toggle" onClick={() => { setJobsOpen((value) => !value); if (!jobsOpen) void refreshDrift(); }}><strong>Jobs</strong><span>{boot.recovery.length || drift.length ? `${boot.recovery.length} recovery · ${drift.length} drift` : "No active jobs"}</span><span>{jobsOpen ? "Close" : "Open"}</span></button>{jobsOpen && <div className="jobs-body">{boot.recovery.filter((item) => item.projectId === project.projectId).map((item) => <div className="job-row" key={item.transactionId}><StatusBadge status="ERROR" /><div><strong>Interrupted apply {item.transactionId}</strong><p>{item.summary}</p></div><button type="button" onClick={async () => { const result = await window.boxspec.inspectRecovery({ projectId: project.projectId, transactionId: item.transactionId }); if (result.ok) setRecovery(result.data); else reportError(result); }}>Inspect recovery</button></div>)}{drift.map((item) => <div className="job-row" key={item.driftId}><StatusBadge status="STALE" /><div><strong>Source drift</strong><p>{item.paths.join(", ")}</p><p>{capabilities.reasons?.drift}</p></div><div className="button-row"><button disabled={!capabilities.drift} type="button" onClick={() => void resolveDrift(item.driftId, "propose-contract")}>Propose contract update</button><button disabled={!capabilities.drift} type="button" onClick={() => void resolveDrift(item.driftId, "restore-contract")}>Restore contract layout</button><button disabled={!capabilities.drift} type="button" onClick={() => void resolveDrift(item.driftId, "unmanage")}>Stop managing</button></div></div>)}{boot.recovery.length === 0 && drift.length === 0 && <EmptyState title="No jobs" detail="Verification, apply, drift, and recovery events appear here." />}</div>}</section>
      {wizardOpen && <ClientWizard projectId={project.projectId} statuses={clients} onClose={() => setWizardOpen(false)} onError={reportError} onRefresh={refreshClients} />}
      {themeOpen && <ThemeGallery themes={themes} currentThemeId={screen?.designSystem.id ?? null} onApply={applyTheme} onOpenSource={(url) => void openThemeSource(url)} onClose={() => setThemeOpen(false)} applying={themeApplying} error={themeError} />}
      {recovery && <RecoveryDialog projectId={project.projectId} inspection={recovery} onClose={() => setRecovery(null)} onError={reportError} onRecovered={() => { setRecovery(null); window.boxspec.bootstrap().then((result) => { if (result.ok) setBoot(result.data); }); }} />}
    </main>
  );

  async function resolveDrift(driftId: string, resolution: "propose-contract" | "restore-contract" | "unmanage") {
    if (!project) return;
    const result = await window.boxspec.resolveDrift({ projectId: project.projectId, driftId, resolution });
    if (!result.ok) return reportError(result);
    await refreshDrift();
  }
}

function parentDepth(id: string, nodes: EditorScreen["nodes"]): number { let depth = 0; let current = nodes.find((node) => node.id === id); const seen = new Set<string>(); while (current?.parentId && !seen.has(current.parentId)) { seen.add(current.parentId); depth += 1; current = nodes.find((node) => node.id === current?.parentId); } return depth; }

function applyEditorCommand(current: EditorScreen, command: EditorCommand, nextRevision = current.revision + 1): EditorScreen | null {
  const contract = structuredClone(current);
  contract.revision = nextRevision;
  const node = contract.nodes.find((entry) => entry.id === ("nodeId" in command ? command.nodeId : ""));
  switch (command.type) {
    case "rename-node": if (!node) return null; node.name = command.name; break;
    case "set-size": if (!node) return null; node.layout[command.axis] = command.rule; break;
    case "set-layout": if (!node) return null; node.layout.mode = command.mode; break;
    case "set-policy": {
      if (!node) return null;
      const replacement = command.policy === "soft" ? { path: command.path, policy: "soft" as const, min: command.min ?? 0, max: command.max ?? 0 } : { path: command.path, policy: command.policy };
      node.locks = [...node.locks.filter((lock) => !(lock.path === command.path || command.path.startsWith(`${lock.path}/`) || lock.path.startsWith(`${command.path}/`))), replacement];
      break;
    }
    case "move-node": {
      if (!node || node.id === contract.rootNodeId) return null;
      const placement = typeof node.placement === "object" && node.placement !== null ? node.placement as Record<string, unknown> : {};
      node.placement = { kind: "anchor", anchorX: "left", anchorY: "top", offsetX: (typeof placement.offsetX === "number" ? placement.offsetX : 0) + command.deltaX, offsetY: (typeof placement.offsetY === "number" ? placement.offsetY : 0) + command.deltaY, zIndex: typeof placement.zIndex === "number" ? placement.zIndex : 0 };
      break;
    }
    case "create-region": {
      const id = `region_${crypto.randomUUID().replaceAll("-", "")}`;
      contract.nodes.push({
        id, parentId: command.parentId, order: contract.nodes.filter((entry) => entry.parentId === command.parentId).length,
        name: command.name, role: "container", visible: true,
        layout: { mode: "leaf", width: { mode: "fixed", value: command.width }, height: { mode: "fixed", value: command.height }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 0, align: "stretch", justify: "start" },
        placement: { kind: "anchor", anchorX: "left", anchorY: "top", offsetX: command.x, offsetY: command.y, zIndex: 0 },
        content: {}, slot: { ownership: "managed", componentKey: null, sourcePath: null, exportName: null }, locks: [], responsive: [],
      });
      break;
    }
    case "delete-node": {
      if (!node || node.id === contract.rootNodeId) return null;
      const removed = new Set([node.id]);
      let changed = true;
      while (changed) { changed = false; for (const entry of contract.nodes) if (entry.parentId && removed.has(entry.parentId) && !removed.has(entry.id)) { removed.add(entry.id); changed = true; } }
      contract.nodes = contract.nodes.filter((entry) => !removed.has(entry.id));
      break;
    }
    case "duplicate-node": {
      if (!node || node.id === contract.rootNodeId) return null;
      const id = `${node.id}_copy_${crypto.randomUUID().replaceAll("-", "")}`;
      contract.nodes.push({ ...structuredClone(node), id, name: `${node.name} copy`, order: contract.nodes.filter((entry) => entry.parentId === node.parentId).length });
      break;
    }
    case "resize-node": {
      if (!node || node.id === contract.rootNodeId) return null;
      const horizontal = command.edge.includes("e") || command.edge.includes("w");
      const vertical = command.edge.includes("n") || command.edge.includes("s");
      if (horizontal) node.layout.width = { mode: "fixed", value: Math.max(8, (node.layout.width.mode === "fixed" ? node.layout.width.value ?? 100 : 100) + (command.edge.includes("w") ? -command.deltaX : command.deltaX)) };
      if (vertical) node.layout.height = { mode: "fixed", value: Math.max(8, (node.layout.height.mode === "fixed" ? node.layout.height.value ?? 100 : 100) + (command.edge.includes("n") ? -command.deltaY : command.deltaY)) };
      if (node.placement.kind === "anchor") node.placement = { ...node.placement, offsetX: node.placement.offsetX + (command.edge.includes("w") ? command.deltaX : 0), offsetY: node.placement.offsetY + (command.edge.includes("n") ? command.deltaY : 0) };
      break;
    }
    case "group-selected": {
      const selected = contract.nodes.filter((entry) => command.nodeIds.includes(entry.id) && entry.id !== contract.rootNodeId);
      if (selected.length < 2 || selected.some((entry) => entry.parentId !== selected[0]?.parentId)) return null;
      const id = `group_${crypto.randomUUID().replaceAll("-", "")}`;
      const parentId = selected[0]?.parentId ?? contract.rootNodeId;
      contract.nodes.push({ id, parentId, order: Math.min(...selected.map((entry) => entry.order)), name: "Group", role: "container", visible: true, layout: { mode: "overlay", width: { mode: "fill", weight: 1, min: 0 }, height: { mode: "fill", weight: 1, min: 0 }, padding: { top: 0, right: 0, bottom: 0, left: 0 }, gap: 0, align: "stretch", justify: "start" }, placement: { kind: "flow" }, content: {}, slot: { ownership: "managed", componentKey: null, sourcePath: null, exportName: null }, locks: [], responsive: [] });
      selected.forEach((entry, order) => { entry.parentId = id; entry.order = order; });
      break;
    }
    case "ungroup-selected": {
      const selectedIds = new Set(command.nodeIds);
      const groups = contract.nodes
        .filter((entry) => selectedIds.has(entry.id) && entry.id !== contract.rootNodeId)
        .sort((a, b) => a.order - b.order);
      if (groups.length === 0 || groups.some((entry) => entry.layout.mode !== "overlay" || groups.some((other) => other.parentId === entry.id))) return null;
      const groupIds = new Set(groups.map((entry) => entry.id));
      for (const group of groups) {
        const children = contract.nodes.filter((entry) => entry.parentId === group.id).sort((a, b) => a.order - b.order);
        if (children.length === 0) return null;
        const groupPlacement = group.placement;
        if (groupPlacement.kind === "anchor" && children.some((entry) => entry.placement.kind !== "anchor")) return null;
        const siblings = contract.nodes.filter((entry) => entry.parentId === group.parentId && entry.id !== group.id && !groupIds.has(entry.id)).sort((a, b) => a.order - b.order);
        const before = siblings.filter((entry) => entry.order < group.order);
        const after = siblings.filter((entry) => entry.order >= group.order);
        const replacement = children.map((child) => {
          child.parentId = group.parentId;
          if (groupPlacement.kind === "anchor" && child.placement.kind === "anchor") {
            child.placement = { ...child.placement, offsetX: child.placement.offsetX + groupPlacement.offsetX, offsetY: child.placement.offsetY + groupPlacement.offsetY };
          }
          return child;
        });
        [...before, ...replacement, ...after].forEach((entry, order) => { entry.order = order; });
      }
      contract.nodes = contract.nodes.filter((entry) => !groupIds.has(entry.id));
      break;
    }
    case "align-selected": {
      const selected = contract.nodes.filter((entry) => command.nodeIds.includes(entry.id) && entry.id !== contract.rootNodeId);
      if (selected.length < 2 || !canArrangeSelection(selected)) return null;
      const boxes = selected.map(nodeBox);
      const left = Math.min(...boxes.map((box) => box.left));
      const right = Math.max(...boxes.map((box) => box.right));
      const top = Math.min(...boxes.map((box) => box.top));
      const bottom = Math.max(...boxes.map((box) => box.bottom));
      selected.forEach((entry, index) => {
        if (entry.placement.kind !== "anchor") return;
        const box = boxes[index]!;
        if (command.alignment === "left") entry.placement.offsetX = left;
        if (command.alignment === "center-x") entry.placement.offsetX = left + (right - left - box.width) / 2;
        if (command.alignment === "right") entry.placement.offsetX = right - box.width;
        if (command.alignment === "top") entry.placement.offsetY = top;
        if (command.alignment === "center-y") entry.placement.offsetY = top + (bottom - top - box.height) / 2;
        if (command.alignment === "bottom") entry.placement.offsetY = bottom - box.height;
      });
      break;
    }
    case "distribute-selected": {
      const selected = contract.nodes.filter((entry) => command.nodeIds.includes(entry.id) && entry.id !== contract.rootNodeId);
      if (selected.length < 3 || !canArrangeSelection(selected)) return null;
      const ordered = selected.slice().sort((a, b) => command.axis === "horizontal" ? nodeBox(a).left - nodeBox(b).left : nodeBox(a).top - nodeBox(b).top);
      const first = nodeBox(ordered[0]!);
      const last = nodeBox(ordered[ordered.length - 1]!);
      const occupied = ordered.reduce((sum, entry) => sum + (command.axis === "horizontal" ? nodeBox(entry).width : nodeBox(entry).height), 0);
      const span = command.axis === "horizontal" ? last.right - first.left : last.bottom - first.top;
      const gap = (span - occupied) / (ordered.length - 1);
      let cursor = command.axis === "horizontal" ? first.left : first.top;
      for (const entry of ordered) {
        if (entry.placement.kind !== "anchor") return null;
        if (command.axis === "horizontal") { entry.placement.offsetX = cursor; cursor += nodeBox(entry).width + gap; }
        else { entry.placement.offsetY = cursor; cursor += nodeBox(entry).height + gap; }
      }
      break;
    }
    case "reparent-node": {
      if (!node || node.id === contract.rootNodeId || command.parentId === node.id) return null;
      node.parentId = command.parentId; node.order = command.order;
      break;
    }
  }
  return contract;
}

type ArrangeNode = EditorScreen["nodes"][number];

function canArrangeSelection(nodes: ArrangeNode[]): boolean {
  return nodes.every((entry) => entry.parentId === nodes[0]?.parentId
    && entry.placement.kind === "anchor"
    && entry.placement.anchorX === "left"
    && entry.placement.anchorY === "top"
    && entry.layout.width.mode === "fixed"
    && typeof entry.layout.width.value === "number"
    && entry.layout.height.mode === "fixed"
    && typeof entry.layout.height.value === "number");
}

function nodeBox(entry: ArrangeNode): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  if (entry.placement.kind !== "anchor" || entry.layout.width.mode !== "fixed" || entry.layout.height.mode !== "fixed") throw new Error("Unsupported arrangement geometry");
  const width = entry.layout.width.value ?? 0;
  const height = entry.layout.height.value ?? 0;
  return { left: entry.placement.offsetX, top: entry.placement.offsetY, right: entry.placement.offsetX + width, bottom: entry.placement.offsetY + height, width, height };
}

function Welcome({ boot, busy, createOpen, setCreateOpen, onOpen, onCreated, onError, error, clearError }: { boot: BootstrapData; busy: boolean; createOpen: boolean; setCreateOpen(value: boolean): void; onOpen(id: string): void; onCreated(project: ProjectSummary, screens: ScreenSummary[]): void; onError(result: DesktopResult<unknown>): void; error: DesktopResult<unknown> | null; clearError(): void }) {
  return <main className="welcome"><ErrorBanner result={error} onDismiss={clearError} /><header><div className="wordmark">BoxSpec <span>P1</span></div><div data-testid="backend-status">{boot.backend.available ? <StatusBadge status="CONNECTED" /> : <StatusBadge status="OFFLINE" />}</div></header><section className="welcome-body"><div className="welcome-title"><h1>Projects</h1><p>Local layout contracts and verified changes.</p></div>{!boot.backend.available && <div className="runtime-warning" role="alert"><strong>Runtime unavailable</strong><p>{boot.backend.message}. Editing, verification, and apply remain disabled.</p></div>}<div className="project-table"><div className="table-header"><span>Name</span><span>Folder</span><span>Target</span><span /></div>{boot.projects.map((item) => <div className="project-row" key={item.projectId}><strong>{item.name}</strong><code>{item.rootPath ?? "Local state"}</code><span>React / Web</span><button type="button" disabled={busy} onClick={() => onOpen(item.projectId)}>Open</button></div>)}{boot.projects.length === 0 && <EmptyState title="No projects yet" detail="Choose a local React project folder to create the first contract." />}</div><button data-testid="create-project-open" className="primary create-project" type="button" disabled={!boot.backend.available} onClick={() => setCreateOpen(true)}>Create project</button></section>{createOpen && <CreateProject onClose={() => setCreateOpen(false)} onCreated={onCreated} onError={onError} />}</main>;
}

function CreateProject({ onClose, onCreated, onError }: { onClose(): void; onCreated(project: ProjectSummary, screens: ScreenSummary[]): void; onError(result: DesktopResult<unknown>): void }) {
  const [name, setName] = useState(""); const [rootPath, setRootPath] = useState(""); const [busy, setBusy] = useState(false);
  async function choose() { const result = await window.boxspec.chooseDirectory(); if (result.ok && result.data.path) setRootPath(result.data.path); else if (!result.ok) onError(result); }
  async function submit() { if (!name.trim() || !rootPath) return; setBusy(true); const result = await window.boxspec.createProject({ name: name.trim(), rootPath }); setBusy(false); if (result.ok) onCreated(result.data.project, [...result.data.screens]); else onError(result); }
  return <div className="modal-backdrop"><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-project-title"><h2 id="create-project-title">Create project</h2><p>BoxSpec will treat this folder as an approved project root. Build and preview can execute project code. The runtime validates the canonical path before granting access.</p><label>Project name<input data-testid="project-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label><label>Project folder<div className="path-input"><input data-testid="project-root" value={rootPath} onChange={(e) => setRootPath(e.target.value)} placeholder="Absolute local folder path" /><button type="button" onClick={() => void choose()}>Browse…</button></div></label><div className="button-row"><button type="button" onClick={onClose}>Cancel</button><button className="primary" data-testid="create-project-submit" type="button" disabled={!name.trim() || !rootPath || busy} onClick={() => void submit()}>{busy ? "Creating…" : "Create"}</button></div></section></div>;
}

function RecoveryDialog({ projectId, inspection, onClose, onError, onRecovered }: { projectId: string; inspection: RecoveryInspection; onClose(): void; onError(result: DesktopResult<unknown>): void; onRecovered(): void }) {
  const [strategy, setStrategy] = useState<"finish-after" | "restore-before">("restore-before");
  const unknown = inspection.paths.filter((entry) => entry.state === "UNKNOWN");
  const [decisions, setDecisions] = useState<Record<string, "preserve-current" | "finish-after" | "restore-before">>(() => Object.fromEntries(unknown.map((entry) => [entry.path, "preserve-current"])));
  const [busy, setBusy] = useState(false);
  async function recover() { setBusy(true); const result = await window.boxspec.resolveRecovery({ projectId, recovery: { transactionId: inspection.transactionId, recoveryNonce: inspection.recoveryNonce, strategy, unknownPathDecisions: unknown.map((entry) => ({ path: entry.path, action: decisions[entry.path] ?? "preserve-current" })) } }); setBusy(false); if (result.ok) onRecovered(); else onError(result); }
  return <div className="modal-backdrop"><section className="create-dialog recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title"><h2 id="recovery-title">Interrupted apply recovery</h2><p>Journal {inspection.journalHash.slice(0, 12)}. Review each ambiguous file; BoxSpec will reject this nonce if the journal changes.</p><label>Default action<select value={strategy} onChange={(event) => setStrategy(event.target.value as "finish-after" | "restore-before")}><option value="restore-before">Restore before state</option><option value="finish-after">Finish intended apply</option></select></label><div className="recovery-paths">{inspection.paths.map((entry) => <div key={entry.path}><code>{entry.path}</code><StatusBadge status={entry.state === "UNKNOWN" ? "ERROR" : entry.state === "AFTER" ? "PASS" : "UNVERIFIED"} />{entry.state === "UNKNOWN" && <select aria-label={`Recovery action for ${entry.path}`} value={decisions[entry.path]} onChange={(event) => setDecisions((current) => ({ ...current, [entry.path]: event.target.value as "preserve-current" | "finish-after" | "restore-before" }))}><option value="preserve-current">Preserve current</option><option value="restore-before">Restore before</option><option value="finish-after">Apply intended after</option></select>}</div>)}</div><div className="button-row"><button onClick={onClose}>Cancel</button><button className="primary danger-confirm" disabled={busy} onClick={() => void recover()}>{busy ? "Recovering…" : "Apply recovery decision"}</button></div></section></div>;
}
