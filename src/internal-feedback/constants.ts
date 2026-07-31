// Kept in exact sync with api/internal/feedback-submit.ts's own
// ALLOWED_AREAS/ALLOWED_SEVERITIES -- duplicated (not imported) since that
// file is server-only and reads env vars that must never reach this
// separately-built client bundle. If you change one, change the other.
export const FEEDBACK_AREAS = ["Home", "Discover", "Create a Reserve", "Portfolio", "Manage Reserve", "Reserve Detail", "Internal Dashboard", "Other"] as const;
export const FEEDBACK_SEVERITIES = ["Critical", "High", "Medium", "Low", "Cosmetic"] as const;

export const MAX_SCREENSHOTS = 3;
export const MAX_SCREENSHOT_BYTES = 1_200_000;
