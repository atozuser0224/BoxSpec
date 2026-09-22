import type { CheckStatus, DesktopResult } from "../../common/ipc";

export function StatusBadge({ status }: { status: CheckStatus | "SAVED" | "MODIFIED" | "OFFLINE" | "CONNECTED" }) {
  return <span className={`status status-${status.toLowerCase()}`}>{status}</span>;
}

export function ErrorBanner({ result, onDismiss }: { result: DesktopResult<unknown> | null; onDismiss(): void }) {
  if (!result || result.ok) return null;
  return (
    <div className="error-banner" role="alert">
      <strong>{result.error.code}</strong>
      <span>{result.error.message}</span>
      <button type="button" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><strong>{title}</strong><span>{detail}</span></div>;
}
