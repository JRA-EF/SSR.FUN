import { useRef, useState } from "react";
import { FEEDBACK_AREAS, FEEDBACK_SEVERITIES, MAX_SCREENSHOTS, MAX_SCREENSHOT_BYTES } from "./constants";

interface ScreenshotDraft {
  filename: string;
  mimeType: string;
  base64: string;
  previewUrl: string;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // reader.result is a data: URL ("data:image/png;base64,AAAA...") -- the
      // server only wants the raw base64 payload after the comma.
      const commaIndex = result.indexOf(",");
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

export function Feedback() {
  const [reporterName, setReporterName] = useState("");
  const [area, setArea] = useState<string>(FEEDBACK_AREAS[0]);
  const [severity, setSeverity] = useState<string>(FEEDBACK_SEVERITIES[2]);
  const [description, setDescription] = useState("");
  const [stepsToReproduce, setStepsToReproduce] = useState("");
  const [screenshots, setScreenshots] = useState<ScreenshotDraft[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setReporterName("");
    setArea(FEEDBACK_AREAS[0]);
    setSeverity(FEEDBACK_SEVERITIES[2]);
    setDescription("");
    setStepsToReproduce("");
    setScreenshots([]);
    setFileError(null);
  };

  const handleFilesSelected = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setFileError(null);
    const files = Array.from(fileList);
    if (screenshots.length + files.length > MAX_SCREENSHOTS) {
      setFileError(`You can attach at most ${MAX_SCREENSHOTS} screenshots.`);
      return;
    }
    const drafts: ScreenshotDraft[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setFileError(`"${file.name}" isn't an image -- only screenshots are accepted.`);
        return;
      }
      if (file.size > MAX_SCREENSHOT_BYTES) {
        setFileError(`"${file.name}" is too large -- each screenshot must be under ${Math.floor(MAX_SCREENSHOT_BYTES / 1_000_000)}MB.`);
        return;
      }
      const base64 = await fileToBase64(file);
      drafts.push({ filename: file.name, mimeType: file.type, base64, previewUrl: URL.createObjectURL(file) });
    }
    setScreenshots((prev) => [...prev, ...drafts]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeScreenshot = (index: number) => {
    setScreenshots((prev) => prev.filter((_, i) => i !== index));
  };

  const canSubmit = reporterName.trim().length > 0 && description.trim().length > 0 && submitState !== "submitting";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitState("submitting");
    setSubmitError(null);
    try {
      const res = await fetch("/api/internal/feedback-submit", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reporterName: reporterName.trim(),
          area,
          severity,
          description: description.trim(),
          stepsToReproduce: stepsToReproduce.trim(),
          screenshots: screenshots.map((s) => ({ filename: s.filename, mimeType: s.mimeType, base64: s.base64 })),
        }),
      });
      const json = await res.json().catch(() => ({}) as { error?: string });
      if (res.status === 401) {
        setSubmitState("error");
        setSubmitError("Your session expired -- reload the page and sign in again.");
        return;
      }
      if (!res.ok) {
        setSubmitState("error");
        setSubmitError(json.error || "Submission failed.");
        return;
      }
      setSubmitState("success");
    } catch {
      setSubmitState("error");
      setSubmitError("Network error -- please try again.");
    }
  };

  if (submitState === "success") {
    return (
      <div className="fb-shell fb-center">
        <div className="fb-card fb-fade-in" style={{ textAlign: "center", maxWidth: 440 }}>
          <p style={{ fontSize: 32, marginBottom: 8 }}>✓</p>
          <h1 style={{ marginBottom: 8 }}>Thanks -- logged.</h1>
          <p className="fb-muted" style={{ marginBottom: 24 }}>
            Your report was saved to the team's DevNet feedback log{screenshots.length > 0 ? " with its screenshot(s)" : ""}.
          </p>
          <button
            className="fb-btn fb-btn-primary"
            onClick={() => {
              resetForm();
              setSubmitState("idle");
            }}
          >
            Submit another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="fb-shell">
      <header className="fb-header">
        <div>
          <h1>DevNet Feedback</h1>
          <p className="fb-muted fb-small">Internal team only -- bugs, issues, and fixes observed during DevNet testing.</p>
        </div>
        <a href="/internal/status" className="fb-muted fb-small" style={{ textDecoration: "underline" }}>
          ← Status Dashboard
        </a>
      </header>

      <form className="fb-card fb-fade-in" onSubmit={handleSubmit}>
        <div className="fb-field">
          <label htmlFor="reporterName">Your name</label>
          <input id="reporterName" type="text" value={reporterName} onChange={(e) => setReporterName(e.target.value)} placeholder="e.g. Joao" required />
        </div>

        <div className="fb-field-row">
          <div className="fb-field">
            <label htmlFor="area">Area / page</label>
            <select id="area" value={area} onChange={(e) => setArea(e.target.value)}>
              {FEEDBACK_AREAS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div className="fb-field">
            <label htmlFor="severity">Severity</label>
            <select id="severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {FEEDBACK_SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="fb-field">
          <label htmlFor="description">What happened?</label>
          <textarea
            id="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Describe the bug or feedback..."
            required
          />
        </div>

        <div className="fb-field">
          <label htmlFor="steps">Steps to reproduce (optional)</label>
          <textarea
            id="steps"
            rows={3}
            value={stepsToReproduce}
            onChange={(e) => setStepsToReproduce(e.target.value)}
            placeholder="1. Go to...&#10;2. Click...&#10;3. See..."
          />
        </div>

        <div className="fb-field">
          <label>Screenshots (optional, up to {MAX_SCREENSHOTS})</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void handleFilesSelected(e.target.files)}
            disabled={screenshots.length >= MAX_SCREENSHOTS}
          />
          {fileError && <p className="fb-error">{fileError}</p>}
          {screenshots.length > 0 && (
            <div className="fb-thumbs">
              {screenshots.map((s, i) => (
                <div key={i} className="fb-thumb">
                  <img src={s.previewUrl} alt={s.filename} />
                  <button type="button" className="fb-thumb-remove" onClick={() => removeScreenshot(i)} aria-label={`Remove ${s.filename}`}>
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {submitError && <p className="fb-error">{submitError}</p>}

        <button type="submit" className="fb-btn fb-btn-primary" disabled={!canSubmit}>
          {submitState === "submitting" ? "Submitting..." : "Submit feedback"}
        </button>
      </form>
    </div>
  );
}
