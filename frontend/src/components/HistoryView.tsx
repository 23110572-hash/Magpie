import React from "react";
import { ArrowRight, Ban, Clock, Database, History as HistoryIcon, RotateCcw, Trash2 } from "lucide-react";
import type { WorkflowRun } from "@/types";
import { countryLabel, intentLabel, isTerminal } from "@/types";
import { formatDateTime, formatDuration, timeAgo } from "@/lib/format";

interface HistoryViewProps {
  runs: WorkflowRun[];
  datasetIds: Set<string>;
  onOpenRun: (run: WorkflowRun) => void;
  onViewDataset: (datasetId: string) => void;
  onRerun: (runId: string) => void;
  onCancel: (runId: string) => void;
  onDelete: (run: WorkflowRun) => void;
  onGoHome: () => void;
}

const STATUS_CLS: Record<string, string> = {
  completed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-rose-50 text-rose-700 border-rose-200",
  cancelled: "bg-slate-100 text-slate-600 border-slate-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
};

export const HistoryView: React.FC<HistoryViewProps> = ({ runs, datasetIds, onOpenRun, onViewDataset, onRerun, onCancel, onDelete, onGoHome }) => (
  <div className="w-full max-w-[1200px] mx-auto px-4 py-8">
    <h1 className="text-3xl font-black text-slate-900 tracking-tight">History</h1>
    <p className="text-base text-slate-600 mt-1 mb-6">Every request you ran, what the AI understood, and what it collected.</p>

    {runs.length === 0 ? (
      <div className="card p-12 text-center max-w-2xl mx-auto">
        <div className="w-16 h-16 rounded-2xl bg-amber-50 border border-amber-200 flex items-center justify-center text-amber-600 mx-auto mb-4">
          <HistoryIcon className="w-8 h-8" />
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Nothing here yet</h2>
        <p className="text-base text-slate-600 mb-6">Your requests and their results will be listed here.</p>
        <button type="button" onClick={onGoHome} className="btn-primary">Run your first request</button>
      </div>
    ) : (
      <ul className="space-y-3">
        {runs.map((run) => {
          const running = !isTerminal(run.status);
          const stats = run.stats || {};
          const coverage = stats.coverage;
          const datasetId = stats.dataset_id;
          return (
            <li key={run.id} className="card p-5 hover:border-blue-300 transition-colors flex flex-col md:flex-row md:items-center justify-between gap-4">
              <button type="button" onClick={() => onOpenRun(run)} className="text-left min-w-0 group">
                <h3 className="text-lg font-bold text-slate-900 group-hover:text-blue-700 line-clamp-2">{run.prompt}</h3>
                {run.spec?.understood_as && run.spec.understood_as !== run.prompt && (
                  <p className="text-sm text-slate-600 mt-0.5">Understood as: {run.spec.understood_as}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500 mt-1.5">
                  <span className="flex items-center gap-1" title={formatDateTime(run.created_at)}><Clock className="w-4 h-4" />{timeAgo(run.created_at)}</span>
                  <span>{countryLabel(run.country)}</span>
                  <span>{run.mode || "Balanced"}</span>
                  {run.spec?.intent && <span className="badge bg-blue-50 text-blue-700 border-blue-200">{intentLabel(run.spec.intent)}</span>}
                  {run.status === "completed" && coverage && (
                    <span>{coverage.total} rows · {coverage.with_email} e-mails · {coverage.with_phone} phones{stats.duration_seconds ? ` · ${formatDuration(stats.duration_seconds)}` : ""}</span>
                  )}
                  {running && <span>{Math.round(run.progress)}% · {run.message}</span>}
                </div>
                {(run.status === "failed" || run.status === "cancelled") && run.message && (
                  <p className="text-sm text-rose-700 mt-1 line-clamp-2">{run.message}</p>
                )}
              </button>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <span className={`badge ${STATUS_CLS[run.status] || STATUS_CLS.running}`}>{run.status.toUpperCase()}</span>
                {datasetId && datasetIds.has(datasetId) && (
                  <button type="button" onClick={() => onViewDataset(datasetId)} className="btn-secondary"><Database className="w-4 h-4 text-blue-600" /> Data</button>
                )}
                {running ? (
                  <button type="button" onClick={() => onCancel(run.id)} className="btn-secondary"><Ban className="w-4 h-4" /> Cancel</button>
                ) : (
                  <button type="button" onClick={() => onRerun(run.id)} className="btn-secondary"><RotateCcw className="w-4 h-4 text-blue-600" /> Re-run</button>
                )}
                <button type="button" onClick={() => onDelete(run)} className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label="Delete run">
                  <Trash2 className="w-5 h-5" />
                </button>
                <button type="button" onClick={() => onOpenRun(run)} className="p-2 rounded-lg text-slate-400 hover:text-blue-600" aria-label="Open run">
                  <ArrowRight className="w-5 h-5" />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    )}
  </div>
);
