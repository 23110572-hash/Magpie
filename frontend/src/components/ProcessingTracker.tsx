import React from "react";
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Clock, Loader2, RotateCcw, Sparkles, XCircle } from "lucide-react";
import type { Intent, WorkflowRun } from "@/types";
import { countryLabel, isTerminal, resultCount, resultSentence } from "@/types";
import { formatDuration } from "@/lib/format";

interface ProcessingTrackerProps {
  run: WorkflowRun | null;
  onViewDataset: (datasetId?: string) => void;
  onCancel: (runId: string) => void;
  onRerun: (runId: string, intent?: Intent) => void;
}

// Plain-language steps: what Magpie is doing, never how (no source names or internal counts).
const STEPS: { id: string; label: string }[] = [
  { id: "planning", label: "Understanding your request" },
  { id: "searching", label: "Searching the web and trusted sources" },
  { id: "reading", label: "Reading pages and extracting details" },
  { id: "checking", label: "Checking every result against your request" },
  { id: "merging", label: "Removing duplicates" },
  { id: "contacts", label: "Finding contact details" },
  { id: "storing", label: "Saving your results" },
];
const ORDER = STEPS.map((s) => s.id);
type RowState = "done" | "active" | "pending" | "stopped";

function stateOf(run: WorkflowRun, step: string): RowState {
  const idx = ORDER.indexOf(step);
  if (run.status === "completed") return "done";
  const reached = ORDER.indexOf(run.step);
  if (run.status === "failed" || run.status === "cancelled") {
    const stoppedAt = reached >= 0 ? reached : 0;
    if (idx < stoppedAt) return "done";
    return idx === stoppedAt ? "stopped" : "pending";
  }
  if (reached > idx) return "done";
  return reached === idx ? "active" : "pending";
}

const STATE_STYLE: Record<RowState, string> = {
  done: "text-emerald-700",
  active: "text-blue-700",
  pending: "text-slate-400",
  stopped: "text-rose-600",
};

export const ProcessingTracker: React.FC<ProcessingTrackerProps> = ({ run, onViewDataset, onCancel, onRerun }) => {
  if (!run) return null;
  const running = !isTerminal(run.status);
  const progress = Math.max(0, Math.min(100, run.progress || 0));
  const blocks = Math.round((progress / 100) * 24);
  const found = resultCount(run);
  const failed = run.status === "failed";
  const cancelled = run.status === "cancelled";

  return (
    <section aria-label="Workflow progress" aria-live="polite"
      className="w-full max-w-[820px] card p-5 sm:p-7 mt-6 shadow-xl text-left bg-white/90 backdrop-blur-md">
      <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-100 mb-5">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
            {countryLabel(run.country)} · {run.mode || "Balanced"} mode
          </div>
          <div className="text-lg font-bold text-slate-900 line-clamp-2">“{run.prompt}”</div>
        </div>
        <span className={`badge shrink-0 ${
          run.status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
            : failed ? "bg-rose-50 text-rose-700 border-rose-200"
            : cancelled ? "bg-slate-100 text-slate-600 border-slate-200"
            : "bg-blue-50 text-blue-700 border-blue-200"
        }`}>
          {run.status === "completed" ? <CheckCircle2 className="w-4 h-4" /> : failed ? <AlertTriangle className="w-4 h-4" />
            : cancelled ? <Ban className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
          {run.status === "completed" ? "DONE" : failed ? "FAILED" : cancelled ? "CANCELLED" : "WORKING"}
        </span>
      </div>

      <ol className="space-y-3">
        {STEPS.map(({ id, label }) => {
          const state = stateOf(run, id);
          const Icon = state === "done" ? CheckCircle2 : state === "active" ? Loader2 : state === "stopped" ? XCircle : Clock;
          return (
            <li key={id} className={`flex items-center gap-3 text-base font-semibold ${STATE_STYLE[state]}`}>
              <Icon className={`w-5 h-5 shrink-0 ${state === "active" ? "animate-spin" : ""}`} aria-hidden="true" />
              <span>{label}</span>
            </li>
          );
        })}
      </ol>

      {(failed || cancelled) && run.message && (
        <p className={`mt-5 text-sm rounded-xl px-4 py-3 border ${
          failed ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-slate-50 border-slate-200 text-slate-700"
        }`}>{run.message}</p>
      )}

      <div className="mt-6 pt-4 border-t border-slate-100">
        <div className="flex items-center justify-between gap-3 text-sm font-mono text-slate-600 mb-2">
          <span className="text-blue-600 font-bold tracking-wider hidden sm:inline" aria-hidden="true">
            {"▓".repeat(blocks)}{"░".repeat(24 - blocks)}
          </span>
          <span className="font-bold text-slate-900">
            {Math.round(progress)}%{" "}
            {running ? `· ~${Math.max(1, run.eta_seconds || 1)}s left`
              : run.stats?.duration_seconds ? `· took ${formatDuration(run.stats.duration_seconds)}` : ""}
          </span>
        </div>
        <div className="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden border border-slate-200" role="progressbar"
          aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all duration-500 ${
            failed ? "bg-rose-400" : cancelled ? "bg-slate-400" : "bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500"
          }`} style={{ width: `${Math.max(3, progress)}%` }} />
        </div>
      </div>

      {running && (
        <div className="mt-5 flex justify-end">
          <button type="button" onClick={() => onCancel(run.id)} className="btn-secondary"><Ban className="w-4 h-4" /> Cancel</button>
        </div>
      )}

      {run.status === "completed" && found > 0 && (
        <div className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3.5">
          <p className="flex items-center gap-2 text-emerald-900 text-base font-semibold">
            <Sparkles className="w-5 h-5 text-emerald-600 shrink-0" /> {resultSentence(run)}
          </p>
          <button type="button" onClick={() => onViewDataset(run.stats?.dataset_id)} className="btn-success shrink-0">
            Explore results <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {!running && (failed || cancelled || found === 0) && (
        <div className="mt-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          {run.status === "completed" && <p className="text-base text-slate-700">{resultSentence(run)}</p>}
          <button type="button" onClick={() => onRerun(run.id)} className="btn-secondary sm:ml-auto">
            <RotateCcw className="w-4 h-4" /> Run again
          </button>
        </div>
      )}
    </section>
  );
};
