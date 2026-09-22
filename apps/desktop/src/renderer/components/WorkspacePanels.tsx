import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import "./WorkspacePanels.css";

export interface WorkspacePanelsProps {
  readonly left: ReactNode;
  readonly canvas: ReactNode;
  readonly right: ReactNode;
}

type DrawerSide = "left" | "right";

interface PanelWidths {
  readonly left: number;
  readonly right: number;
}

const PREFERENCE_KEY = "boxspec.workspace-panels.v1";
const LEFT_MIN = 200;
const LEFT_MAX = 360;
const RIGHT_MIN = 272;
const RIGHT_MAX = 440;
const DEFAULT_WIDTHS: PanelWidths = { left: 232, right: 304 };
const RESIZE_STEP = 8;
const LARGE_RESIZE_STEP = 24;
const COMPACT_MAX_WIDTH = 1099;
const COMPACT_MAX_HEIGHT = 719;
const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[contenteditable='true']",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function WorkspacePanels({ left, canvas, right }: WorkspacePanelsProps) {
  const [widths, setWidths] = useState<PanelWidths>(readPanelWidths);
  const [compact, setCompact] = useState(readCompactViewport);
  const [drawer, setDrawer] = useState<DrawerSide | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const drawerControlsRef = useRef<HTMLDivElement>(null);
  const leftPaneRef = useRef<HTMLElement>(null);
  const rightPaneRef = useRef<HTMLElement>(null);
  const leftToggleRef = useRef<HTMLButtonElement>(null);
  const rightToggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const closeDrawer = useCallback((restoreFocus = true) => {
    const restoreTarget = restoreFocusRef.current;
    setDrawer(null);
    if (restoreFocus && restoreTarget) {
      window.requestAnimationFrame(() => restoreTarget.focus({ preventScroll: true }));
    }
  }, []);

  useEffect(() => {
    const handleResize = () => setCompact(readCompactViewport());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const active = document.activeElement;
    if (compact) {
      if (drawer !== null || !(active instanceof HTMLElement)) return;
      const target = leftPaneRef.current?.contains(active)
        ? leftToggleRef.current
        : rightPaneRef.current?.contains(active)
          ? rightToggleRef.current
          : null;
      if (target) window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
      return;
    }
    if (drawer === null && !(active instanceof HTMLElement && drawerControlsRef.current?.contains(active))) return;
    setDrawer(null);
    window.requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }));
  }, [compact, drawer]);

  useEffect(() => {
    if (compact) dragCleanupRef.current?.();
  }, [compact]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ version: 1, leftWidth: widths.left, rightWidth: widths.right }));
    } catch {
      // UI preferences are optional; storage denial must not block the editor.
    }
  }, [widths]);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  useEffect(() => {
    if (!compact || drawer === null) return;
    const pane = drawer === "left" ? leftPaneRef.current : rightPaneRef.current;
    if (!pane) return;
    const frame = window.requestAnimationFrame(() => {
      const first = visibleFocusableElements(pane)[0];
      (first ?? pane).focus({ preventScroll: true });
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || hasExternalModal(pane)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = visibleFocusableElements(pane);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        pane.focus({ preventScroll: true });
      } else if (!pane.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeDrawer, compact, drawer]);

  function openDrawer(side: DrawerSide) {
    restoreFocusRef.current = side === "left" ? leftToggleRef.current : rightToggleRef.current;
    setDrawer(side);
  }

  function beginResize(side: DrawerSide, event: ReactPointerEvent<HTMLDivElement>) {
    if (compact || event.button !== 0) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const separator = event.currentTarget;
    separator.focus({ preventScroll: true });
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = side === "left" ? widths.left : widths.right;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    separator.setPointerCapture(pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const delta = moveEvent.clientX - startX;
      const value = side === "left"
        ? clamp(startWidth + delta, LEFT_MIN, LEFT_MAX)
        : clamp(startWidth - delta, RIGHT_MIN, RIGHT_MAX);
      setWidths((current) => side === "left" ? { ...current, left: value } : { ...current, right: value });
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId);
      if (dragCleanupRef.current === cleanup) dragCleanupRef.current = null;
    };
    const handlePointerEnd = (endEvent: PointerEvent) => {
      if (endEvent.pointerId === pointerId) cleanup();
    };
    dragCleanupRef.current = cleanup;
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
  }

  function handleResizeKey(side: DrawerSide, event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    const step = event.shiftKey ? LARGE_RESIZE_STEP : RESIZE_STEP;
    let operation: "decrease" | "increase" | "minimum" | "maximum" | null = null;
    if (event.key === "Home") operation = "minimum";
    else if (event.key === "End") operation = "maximum";
    else if (event.key === "ArrowLeft") operation = side === "left" ? "decrease" : "increase";
    else if (event.key === "ArrowRight") operation = side === "left" ? "increase" : "decrease";
    if (!operation) return;
    event.preventDefault();
    setWidths((current) => {
      const value = side === "left" ? current.left : current.right;
      const minimum = side === "left" ? LEFT_MIN : RIGHT_MIN;
      const maximum = side === "left" ? LEFT_MAX : RIGHT_MAX;
      const next = operation === "minimum"
        ? minimum
        : operation === "maximum"
          ? maximum
          : clamp(value + (operation === "increase" ? step : -step), minimum, maximum);
      return side === "left" ? { ...current, left: next } : { ...current, right: next };
    });
  }

  const style = {
    "--workspace-left-width": `${widths.left}px`,
    "--workspace-right-width": `${widths.right}px`,
  } as CSSProperties;

  return (
    <div
      data-testid="workspace-panels"
      className="workspace-panels"
      data-compact={compact ? "true" : "false"}
      data-drawer-open={drawer ?? "none"}
      data-left-width={widths.left}
      data-right-width={widths.right}
      style={style}
    >
      <div ref={drawerControlsRef} className="workspace-drawer-controls" hidden={!compact} aria-label="Workspace panels">
        <button
          ref={leftToggleRef}
          data-testid="workspace-drawer-toggle-left"
          type="button"
          aria-controls="workspace-panel-left"
          aria-expanded={drawer === "left"}
          onClick={() => openDrawer("left")}
        >
          Screens &amp; Layers
        </button>
        <button
          ref={rightToggleRef}
          data-testid="workspace-drawer-toggle-right"
          type="button"
          aria-controls="workspace-panel-right"
          aria-expanded={drawer === "right"}
          onClick={() => openDrawer("right")}
        >
          Inspect &amp; Review
        </button>
      </div>

      <div
        data-testid="workspace-drawer-backdrop"
        className="workspace-drawer-backdrop"
        hidden={!compact || drawer === null}
        aria-hidden="true"
        onMouseDown={(event) => { if (event.target === event.currentTarget) closeDrawer(); }}
      />

      <section
        ref={leftPaneRef}
        id="workspace-panel-left"
        data-testid="workspace-panel-left"
        className={`workspace-panel workspace-panel-left ${drawer === "left" ? "drawer-open" : ""}`}
        role={compact && drawer === "left" ? "dialog" : undefined}
        aria-modal={compact && drawer === "left" ? true : undefined}
        aria-labelledby={compact ? "workspace-drawer-title-left" : undefined}
        aria-hidden={compact ? drawer !== "left" : undefined}
        inert={compact ? drawer !== "left" : false}
        tabIndex={-1}
      >
        <header className="workspace-drawer-header" aria-hidden={!compact}>
          <strong id="workspace-drawer-title-left">Screens &amp; Layers</strong>
          <button data-testid="workspace-drawer-close-left" type="button" aria-label="Close screens and layers" onClick={() => closeDrawer()}>Close</button>
        </header>
        <div data-testid="workspace-drawer-left" className="workspace-panel-content">{left}</div>
      </section>

      <div
        data-testid="workspace-resizer-left"
        className="workspace-resizer workspace-resizer-left"
        role="separator"
        tabIndex={compact ? -1 : 0}
        aria-label="Resize screens and layers panel"
        aria-controls="workspace-panel-left"
        aria-orientation="vertical"
        aria-valuemin={LEFT_MIN}
        aria-valuemax={LEFT_MAX}
        aria-valuenow={widths.left}
        aria-valuetext={`${widths.left} pixels`}
        title="Resize screens and layers. Arrow keys: 8 px; Shift: 24 px; Home/End: min/max."
        onPointerDown={(event) => beginResize("left", event)}
        onKeyDown={(event) => handleResizeKey("left", event)}
      />

      <div ref={canvasRef} data-testid="workspace-panel-canvas" className="workspace-panel-canvas" tabIndex={-1}>{canvas}</div>

      <div
        data-testid="workspace-resizer-right"
        className="workspace-resizer workspace-resizer-right"
        role="separator"
        tabIndex={compact ? -1 : 0}
        aria-label="Resize inspector and review panel"
        aria-controls="workspace-panel-right"
        aria-orientation="vertical"
        aria-valuemin={RIGHT_MIN}
        aria-valuemax={RIGHT_MAX}
        aria-valuenow={widths.right}
        aria-valuetext={`${widths.right} pixels`}
        title="Resize inspector and review. Arrow keys: 8 px; Shift: 24 px; Home/End: min/max."
        onPointerDown={(event) => beginResize("right", event)}
        onKeyDown={(event) => handleResizeKey("right", event)}
      />

      <section
        ref={rightPaneRef}
        id="workspace-panel-right"
        data-testid="workspace-panel-right"
        className={`workspace-panel workspace-panel-right ${drawer === "right" ? "drawer-open" : ""}`}
        role={compact && drawer === "right" ? "dialog" : undefined}
        aria-modal={compact && drawer === "right" ? true : undefined}
        aria-labelledby={compact ? "workspace-drawer-title-right" : undefined}
        aria-hidden={compact ? drawer !== "right" : undefined}
        inert={compact ? drawer !== "right" : false}
        tabIndex={-1}
      >
        <header className="workspace-drawer-header" aria-hidden={!compact}>
          <strong id="workspace-drawer-title-right">Inspect &amp; Review</strong>
          <button data-testid="workspace-drawer-close-right" type="button" aria-label="Close inspector and review" onClick={() => closeDrawer()}>Close</button>
        </header>
        <div data-testid="workspace-drawer-right" className="workspace-panel-content">{right}</div>
      </section>
    </div>
  );
}

function readPanelWidths(): PanelWidths {
  if (typeof window === "undefined") return DEFAULT_WIDTHS;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? "null");
    if (!isRecord(parsed) || parsed.version !== 1) return DEFAULT_WIDTHS;
    return {
      left: safeStoredWidth(parsed.leftWidth, LEFT_MIN, LEFT_MAX, DEFAULT_WIDTHS.left),
      right: safeStoredWidth(parsed.rightWidth, RIGHT_MIN, RIGHT_MAX, DEFAULT_WIDTHS.right),
    };
  } catch {
    return DEFAULT_WIDTHS;
  }
}

function readCompactViewport(): boolean {
  return typeof window !== "undefined" && (window.innerWidth <= COMPACT_MAX_WIDTH || window.innerHeight <= COMPACT_MAX_HEIGHT);
}

function safeStoredWidth(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp(Math.round(value), minimum, maximum) : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visibleFocusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.offsetParent !== null);
}

function hasExternalModal(pane: HTMLElement): boolean {
  return [...document.querySelectorAll<HTMLElement>("[aria-modal='true']")]
    .some((modal) => modal !== pane && !pane.contains(modal));
}
