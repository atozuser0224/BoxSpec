import type { ReviewDetail, ReviewSummary, RuntimeCapabilities } from "../../common/ipc";
import { EmptyState, StatusBadge } from "./Status";

interface ReviewPanelProps {
  reviews: ReviewSummary[];
  detail: ReviewDetail | null;
  capabilities: RuntimeCapabilities;
  busy: boolean;
  onOpen(candidateId: string): void;
  onApprove(): void;
}

export function ReviewPanel({ reviews, detail, capabilities, busy, onOpen, onApprove }: ReviewPanelProps) {
  if (!detail && reviews.length === 0) return <aside className="review-panel"><EmptyState title="No candidates" detail="Verified candidates requested for review appear here." /></aside>;
  if (!detail) return <aside className="review-panel"><div className="panel-heading"><strong>Review queue</strong><span>{reviews.length}</span></div>{reviews.map((review) => <button type="button" className="review-row" key={review.candidateId} onClick={() => onOpen(review.candidateId)}><span>{review.candidateId}</span><span className={`status ${review.status === "STALE" ? "status-stale" : "status-unverified"}`}>{review.status}</span></button>)}</aside>;
  const blocking = detail.status !== "PASS" || detail.checks.some((check) => check.status !== "PASS");
  const disabledReason = !capabilities.apply ? capabilities.reasons?.apply ?? "Apply service unavailable" : blocking ? "Every required check must pass" : null;
  return (
    <aside className="review-panel" aria-label="Candidate review">
      <div className="panel-heading"><strong>Candidate review</strong><StatusBadge status={detail.status} /></div>
      <dl className="identity-grid"><dt>Candidate</dt><dd>{detail.candidateId}</dd><dt>Report</dt><dd>{detail.reportId}</dd><dt>Revision</dt><dd>{detail.contractRevision}</dd><dt>Tree hash</dt><dd title={detail.candidateHash}>{detail.candidateHash.slice(0, 12)}</dd></dl>
      <section className="review-section"><h3>Changes</h3>{detail.changes.length ? detail.changes.map((change, index) => <div className="change-row" key={`${change.summary}-${index}`}><span className="change-kind">{change.kind}</span><span>{change.summary}</span>{change.path && <code>{change.path}</code>}</div>) : <p className="muted">No file-level change detail was returned.</p>}</section>
      <section className="review-section"><h3>Required checks</h3>{detail.checks.map((check) => <div className="check-row" key={check.checkId}><StatusBadge status={check.status} /><div><strong>{check.checkId}</strong><p>{check.message}</p></div></div>)}</section>
      <section className="review-section"><h3>Spatial evidence</h3><p className="muted">{detail.spatial.length ? `${detail.spatial.length} measured node changes are overlaid on the canvas.` : "No trusted baseline comparison was returned. Movement vectors are unavailable."}</p></section>
      <div className="approval-bar"><p>{disabledReason ?? "Approval is bound to this candidate, report, policy revision, and fresh review nonce."}</p><button type="button" className="primary danger-confirm" disabled={Boolean(disabledReason) || busy} onClick={onApprove}>{busy ? "Applying…" : "Approve and apply"}</button></div>
    </aside>
  );
}
