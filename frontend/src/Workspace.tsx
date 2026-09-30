import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Layers, ShieldCheck, Sparkles, Wand2 } from "lucide-react";
import { GridPattern } from "@/components/ui/grid-pattern";
import PromptBar from "@/components/ui/prompt-bar";
import { BrandCorner, FloatingNav, UserMenu } from "@/components/FloatingNav";
import { ProcessingTracker } from "@/components/ProcessingTracker";
import { DatasetsView } from "@/components/DatasetsView";
import { LeadsView, type OutreachTemplate } from "@/components/LeadsView";
import { HistoryView } from "@/components/HistoryView";
import { SettingsView } from "@/components/SettingsView";
import { Toasts, type Toast } from "@/components/Toasts";
import { API_BASE, ApiError, api, downloadFile, sleep, streamEvents } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Country, DatasetDetail, DatasetSummary, Intent, Lead, Mode, SystemStatus, Tab, User, WorkflowRun } from "@/types";
import { isTerminal } from "@/types";

/** Prefer the most advanced state; once both are final, the persisted row wins. */
function pickRun(live?: WorkflowRun, polled?: WorkflowRun): WorkflowRun | undefined {
  if (!live) return polled;
  if (!polled) return live;
  const liveDone = isTerminal(live.status);
  const polledDone = isTerminal(polled.status);
  if (liveDone && polledDone) return { ...live, ...polled };
  if (liveDone !== polledDone) return liveDone ? { ...polled, ...live } : polled;
  return (live.progress ?? 0) >= (polled.progress ?? 0) ? { ...polled, ...live } : polled;
}

interface WorkspaceProps {
  user: User;
  onUserChange: (user: User) => void;
  onSignOut: () => void;
}

export function Workspace({ user, onUserChange, onSignOut }: WorkspaceProps) {
  const [tab, setTab] = useState<Tab>("home");
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [offline, setOffline] = useState<string | null>(null);

  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [liveRuns, setLiveRuns] = useState<Record<string, WorkflowRun>>({});
  const [trackedRunId, setTrackedRunId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selectedDatasetId, setSelectedDatasetId] = useState<string | null>(null);
  const [datasetDetail, setDatasetDetail] = useState<DatasetDetail | null>(null);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [sending, setSending] = useState<{ done: number; total: number } | null>(null);
  const [drafting, setDrafting] = useState(false);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const notify = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), kind === "error" ? 8000 : 5000);
  }, []);

  const quiet = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 0) setOffline(err.message);
  }, []);
  const fail = useCallback((err: unknown, fallback = "Something went wrong") => {
    if (err instanceof ApiError && err.status === 401) return; // App shows the sign-in page
    quiet(err);
    notify("error", err instanceof Error ? err.message : fallback);
  }, [notify, quiet]);

  // ------------------------------------------------------------ loaders (state is only set in callbacks)
  const refreshRuns = useCallback(() => api<WorkflowRun[]>("/api/runs?limit=100").then((data) => {
    setRuns(data);
    setOffline(null);
  }).catch(quiet), [quiet]);
  const refreshDatasets = useCallback(() => api<DatasetSummary[]>("/api/datasets").then(setDatasets).catch(quiet), [quiet]);
  const refreshLeads = useCallback(() => api<Lead[]>("/api/leads").then(setLeads).catch(quiet), [quiet]);
  const refreshStatus = useCallback(() => api<SystemStatus>("/api/status").then(setStatus).catch(quiet), [quiet]);

  useEffect(() => {
    void refreshRuns();
    void refreshLeads();
    void refreshStatus();
  }, [refreshRuns, refreshLeads, refreshStatus]);

  const mergedRuns = useMemo(() => runs.map((r) => pickRun(liveRuns[r.id], r) as WorkflowRun), [runs, liveRuns]);
  const runningRuns = mergedRuns.filter((r) => !isTerminal(r.status));
  const anyRunning = runningRuns.length > 0;

  useEffect(() => {
    const id = window.setInterval(() => void refreshRuns(), anyRunning ? 3000 : 15000);
    return () => window.clearInterval(id);
  }, [anyRunning, refreshRuns]);

  const completedSignature = runs.filter((r) => r.status === "completed").map((r) => r.id).join(",");
  useEffect(() => {
    void refreshDatasets();
  }, [completedSignature, refreshDatasets]);

  useEffect(() => {
    if (tab === "leads") void refreshLeads();
    if (tab === "datasets") void refreshDatasets();
    if (tab === "settings") void refreshStatus();
  }, [tab, refreshLeads, refreshDatasets, refreshStatus]);

  // ------------------------------------------------------------ live progress (fetch-based SSE with auth header)
  const trackedRun = useMemo(() => {
    if (!trackedRunId) return null;
    return pickRun(liveRuns[trackedRunId], runs.find((r) => r.id === trackedRunId)) ?? null;
  }, [trackedRunId, liveRuns, runs]);
  const trackedDone = trackedRun ? isTerminal(trackedRun.status) : true;

  useEffect(() => {
    if (!trackedRunId || trackedDone) return;
    const controller = new AbortController();
    let stopped = false;
    const onEvent = (raw: unknown) => {
      const data = raw as WorkflowRun & { run_id?: string };
      const id = data.id || data.run_id;
      if (id !== trackedRunId) return;
      setLiveRuns((prev) => ({ ...prev, [id]: { ...prev[id], ...data, id } }));
      if (isTerminal(data.status)) {
        stopped = true;
        void refreshRuns();
      }
    };
    (async () => {
      while (!stopped && !controller.signal.aborted) {
        try {
          await streamEvents(`/api/runs/${trackedRunId}/events`, onEvent, controller.signal);
        } catch {
          // network hiccup or server restart: retry below
        }
        if (stopped || controller.signal.aborted) return;
        await sleep(2000);
      }
    })();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [trackedRunId, trackedDone, refreshRuns]);

  // ------------------------------------------------------------ datasets
  const effectiveDatasetId = selectedDatasetId ?? datasets[0]?.id ?? null;
  const activeDetail = datasetDetail && datasetDetail.id === effectiveDatasetId ? datasetDetail : null;

  useEffect(() => {
    if (!effectiveDatasetId) return;
    let alive = true;
    api<DatasetDetail>(`/api/datasets/${effectiveDatasetId}`)
      .then((d) => { if (alive) setDatasetDetail(d); })
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 404) {
          setSelectedDatasetId(null);
          void refreshDatasets();
        } else fail(err, "Could not load the dataset");
      });
    return () => { alive = false; };
  }, [effectiveDatasetId, fail, refreshDatasets]);

  const openDataset = useCallback((id?: string) => {
    if (id) setSelectedDatasetId(id);
    setTab("datasets");
  }, []);

  // ------------------------------------------------------------ actions
  const startRun = async (prompt: string, mode: Mode, country: Country) => {
    setSubmitting(true);
    try {
      const run = await api<WorkflowRun>("/api/runs", { method: "POST", json: { prompt, mode, country } });
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setTrackedRunId(run.id);
    } catch (err) {
      fail(err, "Could not start the workflow");
    } finally {
      setSubmitting(false);
    }
  };

  const cancelRun = async (runId: string) => {
    try {
      const run = await api<WorkflowRun>(`/api/runs/${runId}/cancel`, { method: "POST" });
      setRuns((prev) => prev.map((r) => (r.id === run.id ? run : r)));
      setLiveRuns((prev) => ({ ...prev, [run.id]: run }));
      notify("info", "Workflow cancelled");
    } catch (err) {
      fail(err);
    }
  };

  const rerun = async (runId: string, intent?: Intent) => {
    try {
      const run = await api<WorkflowRun>(`/api/runs/${runId}/rerun`, { method: "POST", json: { intent: intent ?? null } });
      setRuns((prev) => [run, ...prev]);
      setTrackedRunId(run.id);
      setTab("home");
    } catch (err) {
      fail(err, "Could not run it again");
    }
  };

  const deleteRun = async (run: WorkflowRun) => {
    if (!window.confirm(`Delete this run and its dataset?\n\n“${run.prompt}”`)) return;
    try {
      await api(`/api/runs/${run.id}`, { method: "DELETE" });
      setRuns((prev) => prev.filter((r) => r.id !== run.id));
      if (trackedRunId === run.id) setTrackedRunId(null);
      if (run.stats?.dataset_id) {
        setDatasets((prev) => prev.filter((d) => d.id !== run.stats?.dataset_id));
        if (run.stats.dataset_id === effectiveDatasetId) setSelectedDatasetId(null);
      }
      notify("success", "Run deleted");
    } catch (err) {
      fail(err);
    }
  };

  const exportDataset = async (dataset: DatasetSummary, format: "csv" | "json") => {
    try {
      await downloadFile(`/api/datasets/${dataset.id}/export/${format}`, `magpie-${dataset.id.slice(0, 8)}.${format}`);
    } catch (err) {
      fail(err, "Export failed");
    }
  };

  const deleteDataset = async (dataset: DatasetSummary) => {
    if (!window.confirm(`Delete “${dataset.label || dataset.name}” and its ${dataset.row_count} rows?`)) return;
    try {
      await api(`/api/datasets/${dataset.id}`, { method: "DELETE" });
      setDatasets((prev) => prev.filter((d) => d.id !== dataset.id));
      setSelectedDatasetId(null);
      notify("success", "Dataset deleted");
    } catch (err) {
      fail(err);
    }
  };

  const addLeads = async (recordIds: string[]) => {
    try {
      const res = await api<{ added: number; already_in_leads: number; with_email: number; leads: Lead[] }>(
        "/api/leads/from-records", { method: "POST", json: { record_ids: recordIds } });
      setLeads((prev) => [...res.leads, ...prev]);
      notify("success", `Added ${res.added} leads (${res.with_email} with an e-mail)` +
        (res.already_in_leads ? `. ${res.already_in_leads} were already in your leads.` : "."));
    } catch (err) {
      fail(err, "Could not add leads");
    }
  };

  const sendLeads = async (ids: string[], template: OutreachTemplate) => {
    const results = { sent: 0, simulated: 0, failed: 0 };
    setSending({ done: 0, total: ids.length });
    for (let i = 0; i < ids.length; i++) {
      try {
        const lead = await api<Lead>(`/api/leads/${ids[i]}/send`, {
          method: "POST", json: { template_subject: template.subject, template_body: template.body },
        });
        setLeads((prev) => prev.map((l) => (l.id === lead.id ? lead : l)));
        if (lead.status === "sent") results.sent++;
        else if (lead.status === "simulated") results.simulated++;
        else results.failed++;
      } catch (err) {
        results.failed++;
        if (ids.length === 1) fail(err, "Sending failed");
      }
      setSending({ done: i + 1, total: ids.length });
    }
    setSending(null);
    const parts = [results.sent && `${results.sent} sent`, results.simulated && `${results.simulated} simulated`,
      results.failed && `${results.failed} failed`].filter(Boolean);
    notify(results.failed ? "error" : "success", parts.join(" · ") || "Nothing sent");
  };

  const draftTemplate = async (goal: string): Promise<OutreachTemplate | null> => {
    setDrafting(true);
    try {
      const res = await api<{ subject: string; body: string; ai: boolean }>("/api/leads/draft", {
        method: "POST", json: { goal: goal || null, dataset_id: leads[0]?.dataset_id ?? null },
      });
      if (!res.ai) notify("info", "AI drafting unavailable, loaded the default template.");
      return { subject: res.subject, body: res.body };
    } catch (err) {
      fail(err, "Could not draft the e-mail");
      return null;
    } finally {
      setDrafting(false);
    }
  };

  const updateLead = async (leadId: string, changes: { email?: string | null }) => {
    try {
      const lead = await api<Lead>(`/api/leads/${leadId}`, { method: "PATCH", json: changes });
      setLeads((prev) => prev.map((l) => (l.id === lead.id ? lead : l)));
    } catch (err) {
      fail(err, "Could not update the lead");
    }
  };

  const deleteLead = async (leadId: string) => {
    try {
      await api(`/api/leads/${leadId}`, { method: "DELETE" });
      setLeads((prev) => prev.filter((l) => l.id !== leadId));
    } catch (err) {
      fail(err);
    }
  };

  const datasetIds = useMemo(() => new Set(datasets.map((d) => d.id)), [datasets]);

  return (
    <div className="relative min-h-screen bg-[#f8fafc] text-slate-900 selection:bg-blue-600 selection:text-white">
      <BrandCorner onClick={() => setTab("home")} />
      <UserMenu user={user} onSettings={() => setTab("settings")} onSignOut={onSignOut} />
      <FloatingNav activeTab={tab} setActiveTab={setTab} runningCount={runningRuns.length}
        onRunningClick={() => {
          if (runningRuns[0]) setTrackedRunId(runningRuns[0].id);
          setTab("home");
        }} />

      <main className="pt-20 lg:pt-28 pb-28 lg:pb-12 print:pt-0 print:pb-0">
        {offline && (
          <div className="mx-auto max-w-3xl px-4 mb-4 print:hidden">
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>Can't reach the Magpie server at <code className="font-mono">{API_BASE}</code>. If it's hosted on Render's free plan it may take ~30 seconds to wake up.</span>
            </div>
          </div>
        )}

        {tab === "home" && (
          <section aria-label="Start a collection" className="relative flex flex-col items-center px-4 overflow-hidden pt-6 lg:pt-10">
            <div className="absolute inset-0 pointer-events-none overflow-hidden">
              <GridPattern
                squares={[[4, 4], [5, 1], [8, 2], [5, 3], [5, 5], [10, 10], [12, 15], [15, 10], [10, 15], [7, 8], [14, 6], [18, 12]]}
                className={cn("[mask-image:radial-gradient(650px_circle_at_center,white,transparent)]",
                  "inset-x-0 inset-y-[-10%] h-[160%] skew-y-6 opacity-40 fill-blue-500/5 stroke-blue-500/10")} />
            </div>
            <div className="relative z-10 text-center max-w-3xl mx-auto mb-8">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-sm font-semibold text-blue-700 mb-5">
                <Sparkles className="w-4 h-4" /> Hi {user.name.split(" ")[0]}, what should Magpie collect?
              </div>
              <h1 className="text-4xl sm:text-6xl font-black text-slate-900 tracking-tight leading-[1.1] mb-5">
                You ask. <span className="bg-gradient-to-r from-blue-600 via-indigo-600 to-cyan-500 bg-clip-text text-transparent">It collects.</span>
              </h1>
              <p className="text-lg sm:text-xl text-slate-600 max-w-2xl mx-auto leading-relaxed">
                Type what you need in your own words - typos and Hinglish are fine. The AI plans the search, reads the
                web, checks every result and gives you a clean, source-backed list with contacts.
              </p>
            </div>
            <div className="relative z-20 w-full flex flex-col items-center">
              <PromptBar onSubmit={startRun} isLoading={submitting} />
              <ProcessingTracker run={trackedRun} onViewDataset={openDataset} onCancel={cancelRun} onRerun={rerun} />
            </div>
            <div className="relative z-10 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-5xl w-full mt-14 text-left">
              {[
                { icon: Wand2, tint: "bg-blue-50 border-blue-200 text-blue-600", title: "Understands anything", text: "Any wording, any city. The AI works out what you mean and designs the search." },
                { icon: ShieldCheck, tint: "bg-emerald-50 border-emerald-200 text-emerald-600", title: "Every row is traceable", text: "Source link, time collected and the raw data it came from - one click away." },
                { icon: Layers, tint: "bg-indigo-50 border-indigo-200 text-indigo-600", title: "Clean and ready to use", text: "AI-checked, duplicates merged, contacts found, export to CSV, JSON or PDF." },
              ].map(({ icon: Icon, tint, title, text }) => (
                <div key={title} className="card p-5">
                  <div className={`w-10 h-10 rounded-xl border flex items-center justify-center mb-3 ${tint}`}><Icon className="w-5 h-5" /></div>
                  <div className="text-base font-bold text-slate-900 mb-1">{title}</div>
                  <div className="text-sm text-slate-600">{text}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {tab === "datasets" && (
          <DatasetsView datasets={datasets} selectedId={effectiveDatasetId} detail={activeDetail}
            loading={!!effectiveDatasetId && !activeDetail} onSelect={setSelectedDatasetId} onAddLeads={addLeads}
            onExport={exportDataset} onDelete={deleteDataset} onGoHome={() => setTab("home")} />
        )}
        {tab === "leads" && (
          <LeadsView leads={leads} status={status} sending={sending} drafting={drafting} onSend={sendLeads}
            onDraft={draftTemplate} onUpdate={updateLead} onDelete={deleteLead} onGoHome={() => setTab("home")} />
        )}
        {tab === "history" && (
          <HistoryView runs={mergedRuns} datasetIds={datasetIds}
            onOpenRun={(run) => { setTrackedRunId(run.id); setTab("home"); }}
            onViewDataset={openDataset} onRerun={(id) => rerun(id)} onCancel={cancelRun} onDelete={deleteRun}
            onGoHome={() => setTab("home")} />
        )}
        {tab === "settings" && (
          <SettingsView user={user} status={status} onUserChange={onUserChange} onSignedOut={onSignOut} notify={notify} />
        )}
      </main>

      <Toasts toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
    </div>
  );
}
