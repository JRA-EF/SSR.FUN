// Gated (same SSR_DASHBOARD_PASSWORD session as /internal/status) internal
// page pointing the team at the real, manually-maintained feedback Sheet --
// no custom form or backend integration. An earlier version of this page
// tried to automate submissions into Drive/Sheets via a Google service
// account, but that route hit organization policy blockers (service-account
// key creation / external sharing restrictions) before it could be
// configured -- removed in favor of this simpler, unblocked link-through.
const FEEDBACK_SHEET_URL = "https://docs.google.com/spreadsheets/d/1Xk-9ngsu9_Gihe0s9Rd72fnzP2apsJ42tWLcfjU5QsM/edit";

export function Feedback() {
  return (
    <div className="fb-shell fb-center">
      <div className="fb-card fb-fade-in" style={{ textAlign: "center", maxWidth: 480 }}>
        <h1 style={{ marginBottom: 8 }}>DevNet Feedback</h1>
        <p className="fb-muted" style={{ marginBottom: 24 }}>
          Internal team only. Log bugs, issues, and fixes observed during DevNet testing directly in the shared sheet -- one row per
          item: date, your name/contact, the page or feature, what happened, and a link to a screenshot or doc if you have one.
        </p>
        <a href={FEEDBACK_SHEET_URL} target="_blank" rel="noreferrer" className="fb-btn fb-btn-primary" style={{ display: "inline-block", textDecoration: "none" }}>
          Open Feedback Sheet →
        </a>
        <p className="fb-muted fb-small" style={{ marginTop: 20 }}>
          <a href="/internal/status" className="fb-muted fb-small" style={{ textDecoration: "underline" }}>
            ← Status Dashboard
          </a>
        </p>
      </div>
    </div>
  );
}
