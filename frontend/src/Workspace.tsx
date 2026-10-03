import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Layers, ShieldCheck, Sparkles, Wand2 } from "lucide-react";
import { CloudBackground } from "@/components/ui/cloud-background";
import PromptBar from "@/components/ui/prompt-bar";
import { BrandCorner, FloatingNav } from "@/components/FloatingNav";
import { ProcessingTracker } from "@/components/ProcessingTracker";
import { DatasetsView } from "@/components/DatasetsView";
import { LeadsView, type OutreachTemplate } from "@/components/LeadsView";
import { HistoryView } from "@/components/HistoryView";
import { SettingsView } from "@/components/SettingsView";
import { CreditsView } from "@/components/CreditsView";
import { CreditsDialog } from "@/components/CreditsDialog";
import { Toasts, type Toast } from "@/components/Toasts";
import { API_BASE, ApiError, api, downloadFile, sleep, streamEvents } from "@/lib/api";
import type {
  Country, CreditsInfo, DatasetDetail, DatasetSummary, Intent, Lead, Mode, PendingAction, SystemStatus, Tab, User,
  WorkflowRun,
} from "@/types";
import { CREDIT_PACKS, MODE_CREDITS, creditsText, isTerminal, modeOf } from "@/types";

/** "no_credits": the balance does not cover the search (checked here first, and always by the server). */
type RunOutcome = "started" | "no_credits" | "failed";

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
  user: User | null; // null = guest: only Home is usable, everything else asks to sign in
  authLoading: boolean;
  onRequireAuth: (action: PendingAction) => void;
  pending: PendingAction | null; // what the user tried to do before signing in
  onPendingConsumed: () => void;
  onUserChange: (user: User) => void;
  onSignOut: () => void;
}

export function Workspace({
  user, authLoading, onRequireAuth, pending, onPendingConsumed, onUserChange, onSignOut,
}: WorkspaceProps) {
  const signedIn = !!user;
  const [tab, setTab] = useState<Tab>(() => (user && pending?.tab) || "home");
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

  const [credits, setCredits] = useState<CreditsInfo | null>(null);
  const [buyingPack, setBuyingPack] = useState<string | null>(null);
  // "You need more credits": the search waiting for a top-up, and the promise that resumes it.
  const [creditAsk, setCreditAsk] = useState<{ mode: Mode; needed: number } | null>(null);
  const creditWaiter = useRef<{ needed: number; resolve: (ok: boolean) => void } | null>(null);
  // A request from before sign-in that did not start goes back into the prompt box.
  const [promptDraft, setPromptDraft] = useState<{ key: number; prompt: string; mode: Mode } | null>(null);
  const balance = credits?.balance ?? user?.credits ?? 0;

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
    if (err instanceof ApiError && err.status === 401) return; // App switches back to guest mode
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
  const refreshCredits = useCallback(() => api<CreditsInfo>("/api/credits").then(setCredits).catch(quiet), [quiet]);

  // Guests have no data: nothing below talks to the API until the visitor signs in.
  useEffect(() => {
    if (!signedIn) return;
    void refreshRuns();
    void refreshLeads();
    void refreshStatus();
  }, [signedIn, refreshRuns, refreshLeads, refreshStatus]);

  const mergedRuns = useMemo(() => runs.map((r) => pickRun(liveRuns[r.id], r) as WorkflowRun), [runs, liveRuns]);
  const runningRuns = mergedRuns.filter((r) => !isTerminal(r.status));
  const anyRunning = runningRuns.length > 0;

  useEffect(() => {
    if (!signedIn) return;
    const id = window.setInterval(() => void refreshRuns(), anyRunning ? 3000 : 15000);
    return () => window.clearInterval(id);
  }, [signedIn, anyRunning, refreshRuns]);

  // Balance: on sign-in, and whenever searches start or finish (a failed search gives its credits back).
  useEffect(() => {
    if (!signedIn) return;
    void refreshCredits();
  }, [signedIn, anyRunning, refreshCredits]);

  const completedSignature = runs.filter((r) => r.status === "completed").map((r) => r.id).join(",");
  useEffect(() => {
    if (!signedIn) return;
    void refreshDatasets();
  }, [signedIn, completedSignature, refreshDatasets]);

  useEffect(() => {
    if (!signedIn) return;
    if (tab === "leads") {
      void refreshLeads();
      void refreshDatasets(); // the Leads page lists your searches
    }
    if (tab === "datasets") void refreshDatasets();
    if (tab === "credits") void refreshCredits();
  }, [signedIn, tab, refreshLeads, refreshDatasets, refreshCredits]);

  /** Every tab except Home needs an account. */
  const goTab = useCallback((next: Tab) => {
    if (!signedIn && next !== "home") {
      onRequireAuth({ tab: next });
      return;
    }
    if (next === "datasets") setSelectedDatasetId(null); // the nav opens the list, not the last dataset
    setTab(next);
  }, [signedIn, onRequireAuth]);

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
  // Nothing opens by itself: the Datasets page starts on the list and the user picks one.
  const effectiveDatasetId = selectedDatasetId;
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

  // ------------------------------------------------------------ credits
  /** Opens "You need more credits"; resolves true once the balance covers the search, false when cancelled. */
  const askForCredits = useCallback((mode: Mode, needed: number) => new Promise<boolean>((resolve) => {
    creditWaiter.current?.resolve(false); // only one search waits at a time
    creditWaiter.current = { needed, resolve };
    setCreditAsk({ mode, needed });
  }), []);

  const settleCredits = useCallback((ok: boolean) => {
    const waiter = creditWaiter.current;
    creditWaiter.current = null;
    setCreditAsk(null);
    waiter?.resolve(ok);
  }, []);
  const cancelCredits = useCallback(() => settleCredits(false), [settleCredits]);

  /** MVP: the pack is added straight away, no payment is taken. Returns the new balance, or null if it failed. */
  const purchase = useCallback(async (packId: string): Promise<number | null> => {
    setBuyingPack(packId);
    try {
      const res = await api<{ balance: number; added: number }>("/api/credits/buy", {
        method: "POST", json: { pack_id: packId },
      });
      setCredits((prev) => (prev ? { ...prev, balance: res.balance } : prev));
      void refreshCredits(); // the history gets the purchase
      notify("success", `Added ${creditsText(res.added)}. You now have ${creditsText(res.balance)}.`);
      return res.balance;
    } catch (err) {
      fail(err, "Could not add the credits");
      return null;
    } finally {
      setBuyingPack(null);
    }
  }, [notify, fail, refreshCredits]);

  const buyPack = (packId: string) => void purchase(packId);

  /** Bought from the dialog: when the balance now covers the waiting search, the dialog closes and it starts. */
  const buyFromDialog = async (packId: string) => {
    const newBalance = await purchase(packId);
    const waiter = creditWaiter.current;
    if (newBalance !== null && waiter && newBalance >= waiter.needed) settleCredits(true);
  };

  // ------------------------------------------------------------ actions
  /** Creates a run; the server charges it, or answers 402 when the balance is too low. */
  const createRun = useCallback(async (path: string, json: unknown, fallback: string): Promise<RunOutcome> => {
    try {
      const run = await api<WorkflowRun>(path, { method: "POST", json });
      setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
      setTrackedRunId(run.id);
      setTab("home");
      void refreshCredits(); // the search was paid for
      return "started";
    } catch (err) {
      if (err instanceof ApiError && err.status === 402) {
        await refreshCredits(); // so the dialog shows the real balance
        return "no_credits";
      }
      fail(err, fallback);
      return "failed";
    }
  }, [fail, refreshCredits]);

  /** Checks the balance first; when it is short, asks for credits and tries again after a purchase. */
  const runWithCredits = useCallback(async (mode: Mode, create: () => Promise<RunOutcome>): Promise<boolean> => {
    const needed = MODE_CREDITS[mode];
    let outcome: RunOutcome = balance >= needed ? await create() : "no_credits";
    while (outcome === "no_credits") {
      if (!(await askForCredits(mode, needed))) return false;
      outcome = await create();
    }
    return outcome === "started";
  }, [balance, askForCredits]);

  /** Returns true when the run started (the prompt box then stays empty). */
  const startRun = useCallback(async (prompt: string, mode: Mode, country: Country): Promise<boolean> => {
    if (!signedIn) {
      onRequireAuth({ run: { prompt, mode, country } }); // runs automatically after sign-in
      return false; // keep the text visible while the sign-in dialog is open
    }
    return runWithCredits(mode, async () => {
      setSubmitting(true);
      try {
        return await createRun("/api/runs", { prompt, mode, country }, "Could not start the workflow");
      } finally {
        setSubmitting(false);
      }
    }); // false (e.g. the credits dialog was cancelled) puts the text back in the box
  }, [signedIn, onRequireAuth, runWithCredits, createRun]);

  // Carry out what the visitor tried to do before signing in (the tab was restored in useState).
  useEffect(() => {
    if (!signedIn || !pending) return;
    const timer = window.setTimeout(() => {
      onPendingConsumed();
      if (!pending.run) return;
      const { prompt, mode, country } = pending.run;
      void startRun(prompt, mode, country).then((started) => {
        if (!started) setPromptDraft({ key: Date.now(), prompt, mode });
      });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [signedIn, pending, onPendingConsumed, startRun]);

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

  /** A re-run is a new search and is charged again, at the cost of the original run's mode. */
  const rerun = async (runId: string, intent?: Intent) => {
    const mode = modeOf(runs.find((r) => r.id === runId)?.mode);
    await runWithCredits(mode, () =>
      createRun(`/api/runs/${runId}/rerun`, { intent: intent ?? null }, "Could not run it again"));
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

  /** Leads page: every result with an e-mail in the chosen search becomes a lead (already-added ones are skipped). */
  const openLeadsForDataset = async (datasetId: string) => {
    try {
      const detail = await api<DatasetDetail>(`/api/datasets/${datasetId}`);
      const withEmail = detail.records.filter((r) => r.email).map((r) => r.id);
      if (!withEmail.length) return;
      const res = await api<{ leads: Lead[] }>("/api/leads/from-records", { method: "POST", json: { record_ids: withEmail } });
      if (res.leads.length) {
        const added = new Set(res.leads.map((l) => l.id));
        setLeads((prev) => [...res.leads, ...prev.filter((l) => !added.has(l.id))]);
      }
    } catch (err) {
      fail(err, "Could not load the contacts for this search");
    }
  };

  const draftTemplate = async (goal: string, datasetId: string | null): Promise<OutreachTemplate | null> => {
    setDrafting(true);
    try {
      const res = await api<{ subject: string; body: string; ai: boolean }>("/api/leads/draft", {
        method: "POST", json: { goal: goal || null, dataset_id: datasetId },
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
      {tab === "home" && <CloudBackground />}
      <BrandCorner onClick={() => setTab("home")} />
      <FloatingNav activeTab={tab} onTab={goTab} runningCount={runningRuns.length}
        onRunningClick={() => {
          if (runningRuns[0]) setTrackedRunId(runningRuns[0].id);
          setTab("home");
        }}
        user={user} creditBalance={user ? balance : null} authLoading={authLoading} onSignIn={() => onRequireAuth({})}
        onCredits={() => setTab("credits")} onSettings={() => setTab("settings")} onSignOut={onSignOut} />

      <main className="relative z-10 pt-20 lg:pt-28 pb-28 lg:pb-12 print:pt-0 print:pb-0">
        {offline && (
          <div className="mx-auto max-w-3xl px-4 mb-4 print:hidden">
            <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800" role="alert">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <span>Can't reach the Magpie server at <code className="font-mono">{API_BASE}</code>. If it's hosted on Render's free plan it may take ~30 seconds to wake up.</span>
            </div>
          </div>
        )}

        {tab === "home" && (
          <section aria-label="Start a collection" className="relative flex flex-col items-center px-4 pt-6 lg:pt-10">
            <div className="relative z-10 text-center max-w-4xl mx-auto mb-8">
              <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-sm font-semibold text-blue-700 mb-5">
                <Sparkles className="w-4 h-4" />
                {user ? `Hi ${user.name.split(" ")[0]}, what should Magpie collect?` : "Smart Data Intelligence System"}
              </div>
              <h1 className="text-4xl sm:text-6xl font-black text-slate-900 tracking-tight leading-[1.1] mb-5">
                Start with a{" "}
                <span className="bg-gradient-to-r from-blue-600 via-indigo-600 to-cyan-500 bg-clip-text text-transparent">question...</span>
              </h1>
              <p className="text-lg sm:text-xl text-slate-600 mx-auto leading-relaxed md:whitespace-nowrap">
                Describe what you're looking for and let Magpie help you explore.
              </p>
            </div>
            <div className="relative z-20 w-full flex flex-col items-center">
              <PromptBar key={promptDraft?.key ?? 0} initial={promptDraft} onSubmit={startRun} isLoading={submitting}
                showCredits={signedIn} userId={user?.id ?? null} />
              {!user && !authLoading && (
                <p className="mt-4 text-sm text-slate-600 text-center">
                  Type your request and press enter - you'll be asked to{" "}
                  <button type="button" onClick={() => onRequireAuth({})} className="font-semibold text-blue-700 hover:underline">
                    sign in or create a free account
                  </button>{" "}
                  first, then it starts automatically.
                </p>
              )}
              <ProcessingTracker run={trackedRun} onViewDataset={openDataset} onCancel={cancelRun} onRerun={rerun} />
            </div>
            <div className="relative z-10 grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-5xl w-full mt-14 text-left">
              {[
                { icon: Wand2, tint: "bg-blue-50 border-blue-200 text-blue-600", title: "Find anything", text: "Any requirement - Magpie will find out what you want and design the search." },
                { icon: ShieldCheck, tint: "bg-emerald-50 border-emerald-200 text-emerald-600", title: "Every finding is traceable", text: "Source link and the raw data it came from - one click away." },
                { icon: Layers, tint: "bg-indigo-50 border-indigo-200 text-indigo-600", title: "Clean and ready to use", text: "Magpie-checked, duplicates merged, contacts found, and you can export it in CSV, JSON or PDF format." },
              ].map(({ icon: Icon, tint, title, text }) => (
                <div key={title} className="card p-5 bg-white/75 backdrop-blur-md border-white/80">
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
          <LeadsView sender={user ? { name: user.name, email: user.email } : null}
            datasets={datasets} leads={leads} status={status} sending={sending} drafting={drafting}
            onOpenDataset={openLeadsForDataset} onSend={sendLeads} onDraft={draftTemplate} onUpdate={updateLead}
            onDelete={deleteLead} onGoHome={() => setTab("home")} />
        )}
        {tab === "history" && (
          <HistoryView runs={mergedRuns} datasetIds={datasetIds}
            onOpenRun={(run) => { setTrackedRunId(run.id); setTab("home"); }}
            onViewDataset={openDataset} onRerun={(id) => rerun(id)} onCancel={cancelRun} onDelete={deleteRun}
            onGoHome={() => setTab("home")} />
        )}
        {tab === "credits" && user && (
          <CreditsView balance={balance} credits={credits} buyingPack={buyingPack} onBuy={buyPack} />
        )}
        {tab === "settings" && user && (
          <SettingsView user={user} onUserChange={onUserChange} onSignedOut={onSignOut} notify={notify} />
        )}
      </main>

      {creditAsk && (
        <CreditsDialog mode={creditAsk.mode} needed={creditAsk.needed} balance={balance}
          packs={credits?.packs ?? CREDIT_PACKS} buyingPack={buyingPack}
          onBuy={(packId) => void buyFromDialog(packId)} onCancel={cancelCredits} />
      )}
      <Toasts toasts={toasts} onDismiss={(id) => setToasts((prev) => prev.filter((t) => t.id !== id))} />
    </div>
  );
}
