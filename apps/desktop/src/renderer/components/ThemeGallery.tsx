import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { ThemeGalleryItem } from "../../common/ipc";
import "./ThemeGallery.css";

export interface ThemeGalleryProps {
  readonly themes: readonly ThemeGalleryItem[];
  readonly currentThemeId: string | null;
  readonly onApply: (themeId: string) => void | Promise<void>;
  readonly onOpenSource: (url: string) => void;
  readonly onClose: () => void;
  readonly applying?: boolean;
  readonly error?: string | null;
}

type ModeFilter = "all" | ThemeGalleryItem["mode"];

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ThemeGallery({ themes, currentThemeId, onApply, onOpenSource, onClose, applying = false, error = null }: ThemeGalleryProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const cardRefs = useRef(new Map<string, HTMLButtonElement>());
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(false);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ModeFilter>("all");
  const [style, setStyle] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(() => currentThemeId ?? themes[0]?.id ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const styles = useMemo(() => [...new Set(themes.map((theme) => theme.style))].sort((left, right) => left.localeCompare(right)), [themes]);
  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return themes.filter((theme) => {
      if (mode !== "all" && theme.mode !== mode) return false;
      if (style !== "all" && theme.style !== style) return false;
      if (!normalizedQuery) return true;
      const haystack = [theme.name, theme.description, theme.style, theme.source.name, theme.typography.body, theme.typography.display, ...theme.tags]
        .join(" ")
        .toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [mode, query, style, themes]);
  const selected = themes.find((theme) => theme.id === selectedId) ?? themes.find((theme) => theme.id === currentThemeId) ?? themes[0] ?? null;
  const isBusy = applying || submitting;

  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => { busyRef.current = isBusy; }, [isBusy]);

  useEffect(() => {
    if (selectedId && themes.some((theme) => theme.id === selectedId)) return;
    setSelectedId(currentThemeId && themes.some((theme) => theme.id === currentThemeId) ? currentThemeId : themes[0]?.id ?? null);
  }, [currentThemeId, selectedId, themes]);

  useEffect(() => {
    if (filtered.length === 0 || filtered.some((theme) => theme.id === selectedId)) return;
    setSelectedId(filtered[0]?.id ?? null);
  }, [filtered, selectedId]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    searchRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      previousFocus?.focus({ preventScroll: true });
    };
  }, []);

  function selectRelative(themeId: string, direction: -1 | 1 | "first" | "last") {
    const index = filtered.findIndex((theme) => theme.id === themeId);
    if (index < 0 || filtered.length === 0) return;
    const nextIndex = direction === "first"
      ? 0
      : direction === "last"
        ? filtered.length - 1
        : (index + direction + filtered.length) % filtered.length;
    const next = filtered[nextIndex];
    if (!next) return;
    setSelectedId(next.id);
    cardRefs.current.get(next.id)?.focus({ preventScroll: true });
  }

  function handleCardKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, themeId: string) {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      selectRelative(themeId, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      selectRelative(themeId, -1);
    } else if (event.key === "Home") {
      event.preventDefault();
      selectRelative(themeId, "first");
    } else if (event.key === "End") {
      event.preventDefault();
      selectRelative(themeId, "last");
    }
  }

  async function applySelected() {
    if (!selected || selected.id === currentThemeId || isBusy) return;
    setSubmitting(true);
    setApplyError(null);
    try {
      await onApply(selected.id);
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : "Theme application failed.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleBackdrop(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget && !isBusy) onClose();
  }

  return (
    <div className="theme-gallery-backdrop" onMouseDown={handleBackdrop}>
      <section ref={dialogRef} data-testid="theme-gallery" className="theme-gallery" role="dialog" aria-modal="true" aria-labelledby="theme-gallery-title">
        <header className="theme-gallery-header">
          <div>
            <h2 id="theme-gallery-title">Design themes</h2>
            <p>Apply presentation tokens to the current boxes. Layout, node IDs, and geometry stay unchanged.</p>
          </div>
          <button data-testid="theme-close" type="button" onClick={onClose} disabled={isBusy} aria-label="Close design themes">Close</button>
        </header>

        <div className="theme-gallery-filters">
          <label className="theme-search-label">
            <span>Search themes</span>
            <input ref={searchRef} data-testid="theme-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, style, tag, source…" />
          </label>
          <fieldset data-testid="theme-mode-filter" className="theme-mode-filter">
            <legend>Mode</legend>
            {(["all", "light", "dark", "mixed"] as const).map((value) => (
              <button key={value} type="button" className={mode === value ? "active" : ""} aria-pressed={mode === value} onClick={() => setMode(value)}>
                {value === "all" ? "All" : capitalize(value)}
              </button>
            ))}
          </fieldset>
          <label className="theme-style-filter">
            <span>Style</span>
            <select data-testid="theme-style-filter" value={style} onChange={(event) => setStyle(event.target.value)}>
              <option value="all">All styles</option>
              {styles.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>

        <div className="theme-gallery-body">
          <section className="theme-library" aria-label="Theme library">
            <div className="theme-results" role="status" aria-live="polite">{filtered.length} of {themes.length} themes</div>
            {filtered.length > 0 ? (
              <div className="theme-grid">
                {filtered.map((theme) => {
                  const isSelected = theme.id === selected?.id;
                  return (
                    <article key={theme.id} className={`theme-card ${isSelected ? "selected" : ""}`} data-selected={isSelected ? "true" : "false"}>
                      <button
                        ref={(element) => { if (element) cardRefs.current.set(theme.id, element); else cardRefs.current.delete(theme.id); }}
                        data-testid={`theme-card-${theme.id}`}
                        data-theme-id={theme.id}
                        type="button"
                        className="theme-card-select"
                        aria-pressed={isSelected}
                        onClick={() => setSelectedId(theme.id)}
                        onKeyDown={(event) => handleCardKeyDown(event, theme.id)}
                      >
                        <TokenStudy theme={theme} compact />
                        <span className="theme-card-copy">
                          <span className="theme-card-title"><strong>{theme.name}</strong>{theme.id === currentThemeId && <em>Current</em>}</span>
                          <span className="theme-card-description">{theme.description}</span>
                          <span className="theme-tags">{theme.tags.slice(0, 3).map((tag) => <span key={tag}>{tag}</span>)}</span>
                        </span>
                      </button>
                      <button data-testid={`theme-source-${theme.id}`} type="button" className="theme-card-source" onClick={() => onOpenSource(theme.source.url)}>
                        Source: {theme.source.name}
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="theme-empty">
                <strong>No matching themes</strong>
                <span>Clear search or change the mode and style filters.</span>
                <button type="button" onClick={() => { setQuery(""); setMode("all"); setStyle("all"); }}>Reset filters</button>
              </div>
            )}
          </section>

          <aside className="theme-detail" aria-label="Selected theme preview">
            {selected ? (
              <>
                <TokenStudy theme={selected} />
                <div className="theme-detail-copy">
                  <div className="theme-detail-heading">
                    <div><span>{capitalize(selected.mode)} · {selected.style}</span><h3>{selected.name}</h3></div>
                    {selected.id === currentThemeId && <strong className="theme-current">Current</strong>}
                  </div>
                  <p>{selected.description}</p>
                  <dl className="theme-summary">
                    <div><dt>Palette</dt><dd className="theme-palette">{selected.palette.slice(0, 6).map((color) => <span key={`${color.role}-${color.hex}`} style={{ background: safeColor(color.hex, "#596275") }} title={`${color.role}: ${color.hex}`} aria-label={`${color.role} ${color.hex}`} />)}</dd></div>
                    <div><dt>Type</dt><dd><strong style={{ fontFamily: selected.typography.display }}>{selected.typography.display}</strong><span style={{ fontFamily: selected.typography.body }}>{selected.typography.body}</span></dd></div>
                    <div><dt>Radius</dt><dd><span className="theme-radius-sample" style={{ borderRadius: `${boundedRadius(selected.tokens.radius)}px` }} />{boundedRadius(selected.tokens.radius)} px</dd></div>
                  </dl>
                  <div className="theme-attribution">
                    <span>This is a generated token study, not an original source screenshot.</span>
                    <button data-testid="theme-source-link" type="button" onClick={() => onOpenSource(selected.source.url)}>Open {selected.source.name}</button>
                    {selected.source.license && <small>{selected.source.license}</small>}
                  </div>
                </div>
              </>
            ) : <div className="theme-empty"><strong>No themes available</strong><span>The local catalog did not provide a valid preset.</span></div>}
          </aside>
        </div>

        <footer className="theme-gallery-footer">
          <span className="theme-gallery-error" role="alert">{applyError ?? error ?? ""}</span>
          <span className="theme-geometry-note">Theme application changes presentation tokens only.</span>
          <button type="button" onClick={onClose} disabled={isBusy}>Cancel</button>
          <button data-testid="theme-apply" type="button" className="primary" disabled={!selected || selected.id === currentThemeId || isBusy} onClick={() => void applySelected()}>
            {isBusy ? "Applying…" : selected?.id === currentThemeId ? "Applied" : "이 테마 적용"}
          </button>
        </footer>
      </section>
    </div>
  );
}

function TokenStudy({ theme, compact = false }: { readonly theme: ThemeGalleryItem; readonly compact?: boolean }) {
  const colors = theme.tokens.colors;
  const previewStyle = {
    "--theme-preview-background": safeColor(colors.background, theme.mode === "dark" ? "#151820" : "#f4f5f7"),
    "--theme-preview-surface": safeColor(colors.surface, theme.mode === "dark" ? "#242936" : "#ffffff"),
    "--theme-preview-text": safeColor(colors.text, theme.mode === "dark" ? "#f2f5fa" : "#1d2430"),
    "--theme-preview-accent": safeColor(colors.accent, "#4f76d8"),
    "--theme-preview-border": safeColor(colors.border, theme.mode === "dark" ? "#424a5a" : "#d7dce5"),
    "--theme-preview-radius": `${boundedRadius(theme.tokens.radius)}px`,
    fontFamily: theme.tokens.fontFamily,
  } as CSSProperties;
  return (
    <span className={`theme-token-study ${compact ? "compact" : ""}`} style={previewStyle} role="img" aria-label={`${theme.name}: ${theme.preview.alt}`}>
      <span className="theme-study-label">Generated token study</span>
      <span className="theme-study-frame" aria-hidden="true">
        <span className="theme-study-header"><i /><i /></span>
        <span className="theme-study-layout">
          <span className="theme-study-sidebar"><i /><i /><i /></span>
          <span className="theme-study-content"><b /><span><i /><i /></span><span><i /><i /></span></span>
        </span>
      </span>
      {!compact && <small>{theme.preview.credit}</small>}
    </span>
  );
}

function safeColor(value: string | undefined, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{3,8}$/iu.test(value.trim()) ? value.trim() : fallback;
}

function boundedRadius(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(32, Math.round(value))) : 4;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toLocaleUpperCase()}${value.slice(1)}`;
}
