import React from "react";
import { AlertTriangle, ArrowRight, Ban, CheckCircle2, Clock, Loader2, RotateCcw, ShieldCheck, XCircle } from "lucide-react";
import type { Intent, WorkflowRun } from "@/types";
import { countryLabel, intentLabel, isTerminal, placeText } from "@/types";
import { formatDuration } from "@/lib/format";

interface ProcessingTrackerProps {
  run: WorkflowRun | null;
  onViewDataset: (datasetId?: string) => void;
  onCancel: (runId: string) => void;
  onRerun: (runId: string, intent?: Intent) => void;
}

const STEPS = ["planning", "searching", "reading", "checking", "merging", "contacts", "storing"];
type RowState = "done" | "active" | "pending" | "stopped";

function stateOf(run: WorkflowRun, step: string): RowState {
  const idx = STEPS.indexOf(step);
  if (run.status === "completed") return "done";
  const reached = STEPS.indexOf(run.step);
  if (run.status === "failed" || run.status === "cancelled") {
    const stoppedAt = reached >= 0 ? reached : lastStepWithData(run);
    if (idx < stoppedAt) return "done";
    return idx === stoppedAt ? "stopped" : "pending";
  }
  if (reached > idx) return "done";
  return reached === idx ? "active" : "pending";
}

function lastStepWithData(run: WorkflowRun): number {
  const s = run.stats || {};
  if (s.coverage) return 6;
  if (s.contacts) return 5;
  if (s.kept != null) return 4;
  if (s.candidates != null) return 3;
  if (s.pages) return 2;
  if (s.web_results != null) return 1;
  return 0;
}

const Row: React.FC<{ state: RowState; label: string; children: React.ReactNode }> = ({ state, label, children }) => {
  const color = { done: "text-emerald-600", active: "text-blue-600", pending: "text-slate-400", stopped: "text-rose-600" }[state];
  const Icon = state === "done" ? CheckCircle2 : state === "active" ? Loader2 : state === "stopped" ? XCircle : Clock;
  return (
    <li className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
      <span className={`font-bold flex items-center gap-2 shrink-0 sm:w-52 ${color}`}>
        <Icon className={`w-5 h-5 ${state === "active" ? "animate-spin" : ""}`} aria-hidden="true" /> {label}
      </span>
      <span className={`text-sm ${state === "pending" ? "text-slate-400" : "text-slate-700"}`}>{children}</span>
    </li>
  );
};

export const ProcessingTracker: React.FC<ProcessingTrackerProps> = ({ run, onViewDataset, onCancel, onRerun }) => {
  if (!run) return null;
  const spec = run.spec || {};
  const stats = run.stats || {};
  const running = !isTerminal(run.status);
  const progress = Math.max(0, Math.min(100, run.progress || 0));
  const blocks = Math.round((progress / 100) * 24);
  const coverage = stats.coverage;
  const sourcesQueried = Object.keys(stats.sources || {}).length;
  const pages = stats.pages || {};

  return (
    <section aria-label="Workflow progress" aria-live="polite"
      className="w-full max-w-[820px] card p-5 sm:p-7 mt-6 shadow-xl text-left">
      <div className="flex items-start justify-between gap-3 pb-4 border-b border-slate-100 mb-5">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold">
            {countryLabel(run.country)} · {run.mode || "Balanced"} mode
          </div>
          <div className="text-lg font-bold text-slate-900 line-clamp-2">“{run.prompt}”</div>
        </div>
        <span className={`badge shrink-0 ${
          run.status === "completed" ? "bg-emerald-50 text-emerald-700 border-emerald-200"
            : run.status === "failed" ? "bg-rose-50 text-rose-700 border-rose-200"
            : run.status === "cancelled" ? "bg-slate-100 text-slate-600 border-slate-200"
            : "bg-blue-50 text-blue-700 border-blue-200"
        }`}>
          {run.status === "completed" ? <CheckCircle2 className="w-4 h-4" /> : run.status === "failed" ? <AlertTriangle className="w-4 h-4" />
            : run.status === "cancelled" ? <Ban className="w-4 h-4" /> : <Loader2 className="w-4 h-4 animate-spin" />}
          {run.status.toUpperCase()}
        </span>
      </div>

      {spec.understood_as && (
        <div className="mb-5 rounded-xl bg-blue-50 border border-blue-200 px-4 py-3">
          <div className="text-sm text-blue-900">
            <span className="font-bold">Understood as:</span> {spec.understood_as}
            {spec.intent && <span className="badge ml-2 bg-white border-blue-200 text-blue-700">{intentLabel(spec.intent)}</span>}
          </div>
          {spec.corrected_prompt && spec.corrected_prompt.toLowerCase() !== run.prompt.toLowerCase() && (
            <div className="text-sm text-blue-800 mt-1">Did you mean: “{spec.corrected_prompt}”</div>
          )}
          {placeText(spec.place) && <div className="text-sm text-blue-800 mt-1">Place: {placeText(spec.place)}</div>}
          {spec.planner_note && <div className="text-sm text-amber-800 mt-1">{spec.planner_note}</div>}
          {!!spec.alternatives?.length && (
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <span className="text-sm text-blue-900">Meant something else?</span>
              {spec.alternatives.map((alt) => (
                <button key={alt.intent} type="button" onClick={() => onRerun(run.id, alt.intent)}
                  className="text-sm px-3 py-1 rounded-full bg-white border border-blue-300 text-blue-800 font-semibold hover:bg-blue-100">
                  Search {intentLabel(alt.intent).toLowerCase()}: {alt.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <ol className="space-y-3.5">
        <Row state={stateOf(run, "planning")} label="Understood">
          {spec.understood_as ? `${spec.sources?.length ?? 0} sources chosen: ${(spec.sources || []).join(", ")}` : "AI is reading your request…"}
        </Row>
        <Row state={stateOf(run, "searching")} label="Searching">
          {stats.web_results != null
            ? `${sourcesQueried} sources queried → ${stats.direct_results ?? 0} direct results, ${stats.web_results} web results`
            : run.step === "searching" ? run.message : "Query the chosen sources in parallel"}
        </Row>
        <Row state={stateOf(run, "reading")} label="Reading pages">
          {pages.opened != null
            ? `${pages.read ?? 0} of ${pages.opened} list pages read → ${pages.entries ?? 0} entries${pages.blocked ? ` (${pages.blocked} blocked by robots.txt/terms)` : ""}`
            : run.step === "reading" ? run.message : "AI picks directories and lists worth reading"}
        </Row>
        <Row state={stateOf(run, "checking")} label="AI relevance check">
          {stats.kept != null
            ? `${stats.kept} of ${stats.checked} candidates kept, ${stats.rejected} rejected`
            : run.step === "checking" ? run.message : "Every candidate is checked against your request"}
        </Row>
        <Row state={stateOf(run, "merging")} label="Duplicates merged">
          {stats.duplicates_merged != null ? `${stats.duplicates_merged} duplicates merged into richer rows` : "Same person/business from different sources becomes one row"}
        </Row>
        <Row state={stateOf(run, "contacts")} label="Finding contacts">
          {stats.contacts
            ? `${stats.contacts.checked ?? 0} websites checked → ${stats.contacts.emails_found ?? 0} e-mails, ${stats.contacts.phones_found ?? 0} phones found`
            : run.step === "contacts" ? run.message : "Published e-mails and phones from their own websites"}
        </Row>
        <Row state={stateOf(run, "storing")} label="Saved">
          {coverage ? `${coverage.total} rows saved with source link and raw snapshot` : "Rows are saved to Neon with provenance"}
        </Row>
      </ol>

      {run.message && (
        <p className={`mt-5 text-sm rounded-xl px-4 py-3 border ${
          run.status === "failed" ? "bg-rose-50 border-rose-200 text-rose-800" : "bg-slate-50 border-slate-200 text-slate-700"
        }`}>{run.message}</p>
      )}

      <div className="mt-5 pt-4 border-t border-slate-100">
        <div className="flex items-center justify-between gap-3 text-sm font-mono text-slate-600 mb-2">
          <span className="text-blue-600 font-bold tracking-wider hidden sm:inline" aria-hidden="true">
            {"▓".repeat(blocks)}{"░".repeat(24 - blocks)}
          </span>
          <span className="font-bold text-slate-900">
            {Math.round(progress)}% {running ? `· ~${Math.max(1, run.eta_seconds || 1)}s left` : stats.duration_seconds ? `· took ${formatDuration(stats.duration_seconds)}` : ""}
          </span>
        </div>
        <div className="w-full h-2.5 rounded-full bg-slate-100 overflow-hidden border border-slate-200" role="progressbar"
          aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`h-full rounded-full transition-all duration-500 ${
            run.status === "failed" ? "bg-rose-400" : run.status === "cancelled" ? "bg-slate-400" : "bg-gradient-to-r from-blue-600 via-cyan-500 to-emerald-500"
          }`} style={{ width: `${Math.max(3, progress)}%` }} />
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
        {running && (
          <button type="button" onClick={() => onCancel(run.id)} className="btn-secondary"><Ban className="w-4 h-4" /> Cancel</button>
        )}
        {!running && (run.status !== "completed" || !coverage?.total) && (
          <button type="button" onClick={() => onRerun(run.id)} className="btn-secondary"><RotateCcw className="w-4 h-4" /> Run again</button>
        )}
      </div>

      {run.status === "completed" && !!coverage?.total && (
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3.5">
          <div className="flex items-start gap-2 text-emerald-900 text-sm">
            <ShieldCheck className="w-5 h-5 text-emerald-600 shrink-0" />
            <span>
              <strong>{coverage.total} rows ready.</strong> Out of {coverage.total}, {coverage.with_email} have an e-mail
              and {coverage.with_phone} have a phone number.
            </span>
          </div>
          <button type="button" onClick={() => onViewDataset(stats.dataset_id)} className="btn-success shrink-0">
            Explore results <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </section>
  );
};
