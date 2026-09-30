import React, { useMemo, useState } from "react";
import {
  AlertTriangle, Building, CheckCircle2, CheckSquare, Clock, ExternalLink, FlaskConical, Loader2, Mail, Pencil, Phone,
  Send, Sparkles, Square, Trash2, Users, X, XCircle,
} from "lucide-react";
import type { DatasetSummary, Lead, SystemStatus } from "@/types";
import { intentLabel } from "@/types";
import { safeHref, timeAgo } from "@/lib/format";

export interface OutreachTemplate {
  subject: string;
  body: string;
}

interface LeadsViewProps {
  sender: Sender | null;
  datasets: DatasetSummary[];
  leads: Lead[];
  status: SystemStatus | null;
  sending: { done: number; total: number } | null;
  drafting: boolean;
  /** Makes sure every result with an e-mail in this search is available as a lead. */
  onOpenDataset: (datasetId: string) => Promise<void>;
  onSend: (leadIds: string[], template: OutreachTemplate) => Promise<void>;
  onDraft: (goal: string, datasetId: string | null) => Promise<OutreachTemplate | null>;
  onUpdate: (leadId: string, changes: { email?: string | null }) => Promise<void>;
  onDelete: (leadId: string) => Promise<void>;
  onGoHome: () => void;
}

// Sent by Team Magpie on behalf of the signed-in user; replies go straight to the user.
const DEFAULT_TEMPLATE: OutreachTemplate = {
  subject: "{sender} is looking for {looking_for}",
  body:
    "Hi {name},\n\nThis is Team Magpie. {sender} is looking for {looking_for} and would love to connect with you.\n\n" +
    "You can reach {sender} directly at {sender_email}, or simply reply to this e-mail.\n\nBest regards,\nTeam Magpie",
};

export interface Sender {
  name: string;
  email: string;
}

/** Same substitution the server does when sending, so the preview matches the real e-mail. */
const render = (text: string, lead: Lead, sender: Sender | null) => {
  const values: Record<string, string> = {
    name: lead.contact_name || "there",
    company: lead.company || "your team",
    role: lead.role || "this",
    sender: sender?.name || "a Magpie user",
    sender_email: sender?.email || "the reply-to address of this e-mail",
    looking_for: lead.looking_for || "someone with your skills",
  };
  return Object.entries(values).reduce((out, [key, value]) => out.split(`{${key}}`).join(value), text);
};

const STATUS: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  queued: { label: "Not sent", cls: "text-amber-800 bg-amber-50 border-amber-200", icon: Clock },
  sent: { label: "Sent", cls: "text-emerald-800 bg-emerald-50 border-emerald-200", icon: CheckCircle2 },
  simulated: { label: "Simulated", cls: "text-indigo-800 bg-indigo-50 border-indigo-200", icon: FlaskConical },
  failed: { label: "Failed", cls: "text-rose-800 bg-rose-50 border-rose-200", icon: XCircle },
};

export const LeadsView: React.FC<LeadsViewProps> = ({
  sender, datasets, leads, status, sending, drafting, onOpenDataset, onSend, onDraft, onUpdate, onDelete, onGoHome,
}) => {
  const [openId, setOpenId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [template, setTemplate] = useState<OutreachTemplate>(DEFAULT_TEMPLATE);
  const [goal, setGoal] = useState("");
  const [filter, setFilter] = useState<"all" | "todo" | "done">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draftEmail, setDraftEmail] = useState("");

  const openDataset = datasets.find((d) => d.id === openId) || null;
  const emailMode = status?.email.mode ?? "simulated";
  const canSend = (l: Lead) => !!l.email && l.status !== "sent";

  // Leads of the open search: everyone with an e-mail, plus anyone added by hand from Datasets.
  const searchLeads = useMemo(() => leads.filter((l) => l.dataset_id === openId), [leads, openId]);
  const visible = useMemo(() => searchLeads.filter((l) => {
    if (filter === "todo") return l.status === "queued" || l.status === "failed";
    if (filter === "done") return l.status === "sent" || l.status === "simulated";
    return true;
  }), [searchLeads, filter]);
  const chosen = selected.filter((id) => searchLeads.some((l) => l.id === id && canSend(l)));
  const preview = searchLeads.find((l) => l.id === chosen[0]) || searchLeads.find(canSend) || searchLeads[0];

  const pick = async (id: string) => {
    setSelected([]);
    setFilter("all");
    setEditing(null);
    if (id === openId) {
      setOpenId(null);
      return;
    }
    setOpenId(id);
    setSyncing(true);
    try {
      await onOpenDataset(id);
    } finally {
      setSyncing(false);
    }
  };

  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  const dispatch = async (ids: string[]) => {
    await onSend(ids, template);
    setSelected((prev) => prev.filter((id) => !ids.includes(id)));
  };
  const draft = async () => {
    const t = await onDraft(goal, openId);
    if (t) setTemplate(t);
  };

  if (datasets.length === 0) {
    return (
      <div className="w-full max-w-3xl mx-auto px-4 py-10">
        <div className="card p-12 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mx-auto mb-4">
            <Users className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">No searches yet</h2>
          <p className="text-base text-slate-600 mb-6">Run a search on Home. Everyone Magpie finds with an e-mail address shows up here, ready to contact.</p>
          <button type="button" onClick={onGoHome} className="btn-primary">Start a search</button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1300px] mx-auto px-4 py-8">
      <div className="mb-4">
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Leads & Outreach</h1>
        <p className="text-base text-slate-600 mt-1">Pick a search to see everyone we found with an e-mail address.</p>
      </div>

      {/* One card per search, in a horizontal bar */}
      <div className="flex gap-3 overflow-x-auto snap-x pb-3 mb-6 -mx-1 px-1" role="tablist" aria-label="Your searches">
        {datasets.map((d) => {
          const isOpen = d.id === openId;
          const emails = d.coverage?.with_email ?? 0;
          return (
            <button key={d.id} type="button" role="tab" aria-selected={isOpen} onClick={() => void pick(d.id)}
              className={`snap-start shrink-0 w-72 text-left rounded-2xl border p-4 transition-all ${
                isOpen
                  ? "bg-emerald-600 border-emerald-600 text-white shadow-lg shadow-emerald-600/25"
                  : "bg-white border-slate-200 text-slate-900 shadow-sm hover:border-emerald-300 hover:shadow-md"
              }`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className={`badge ${isOpen ? "bg-white/15 border-white/30 text-white" : "bg-emerald-50 text-emerald-700 border-emerald-200"}`}>
                  {intentLabel(d.intent) || "Search"}
                </span>
                <span className={`text-xs ${isOpen ? "text-emerald-100" : "text-slate-500"}`}>{timeAgo(d.created_at)}</span>
              </div>
              <div className="text-base font-bold leading-snug line-clamp-2 min-h-[3rem]">{d.label || d.name}</div>
              <div className={`mt-2 flex items-center gap-1.5 text-sm ${isOpen ? "text-emerald-50" : "text-slate-600"}`}>
                <Mail className="w-4 h-4" /> {emails} {emails === 1 ? "e-mail" : "e-mails"} found
              </div>
            </button>
          );
        })}
      </div>

      {!openDataset ? (
        <div className="card p-10 text-center">
          <div className="w-14 h-14 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mx-auto mb-3">
            <Mail className="w-7 h-7" />
          </div>
          <p className="text-lg font-semibold text-slate-900">Select a search above to see who you can e-mail</p>
          <p className="text-base text-slate-600 mt-1">Then write one message and send it to everyone - each e-mail is personalised.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-4">
            <div className="min-w-0">
              <h2 className="text-2xl font-black text-slate-900 tracking-tight">{openDataset.label || openDataset.name}</h2>
              <p className="text-base text-slate-600 mt-1">
                {syncing ? "Loading contacts…" : `${searchLeads.filter((l) => l.email).length} people with an e-mail address`}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" disabled={!searchLeads.some(canSend)}
                onClick={() => setSelected(searchLeads.filter((l) => canSend(l) && l.status !== "simulated").map((l) => l.id))}
                className="btn-secondary">
                Select all
              </button>
              <button type="button" disabled={!chosen.length || !!sending} onClick={() => dispatch(chosen)} className="btn-success">
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                {sending ? `Sending ${sending.done}/${sending.total}…` : `${emailMode === "simulated" ? "Simulate" : "Send"} (${chosen.length})`}
              </button>
              <button type="button" onClick={() => void pick(openDataset.id)} className="btn-ghost" aria-label="Close this search">
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {emailMode === "simulated" && (
            <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600" />
              E-mail sending isn't configured on the server, so sends are only simulated.
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
            <div className="lg:col-span-3 space-y-3">
              <div className="flex flex-wrap gap-2 mb-1" role="tablist" aria-label="Filter leads">
                {([["all", `All (${searchLeads.length})`],
                  ["todo", `To send (${searchLeads.filter((l) => l.status === "queued" || l.status === "failed").length})`],
                  ["done", `Sent (${searchLeads.filter((l) => l.status === "sent" || l.status === "simulated").length})`]] as const).map(([id, label]) => (
                  <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}
                    className={`px-4 py-1.5 rounded-full text-sm font-semibold ${filter === id ? "bg-blue-600 text-white" : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"}`}>
                    {label}
                  </button>
                ))}
              </div>

              {syncing && searchLeads.length === 0 && (
                <div className="card py-12 flex items-center justify-center gap-2 text-base text-slate-500">
                  <Loader2 className="w-5 h-5 animate-spin" /> Loading contacts…
                </div>
              )}

              {visible.map((lead) => {
                const st = STATUS[lead.status] || STATUS.queued;
                const Icon = st.icon;
                const isSelected = chosen.includes(lead.id);
                const href = safeHref(lead.source_url);
                return (
                  <div key={lead.id} className={`card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${isSelected ? "ring-2 ring-emerald-500" : ""}`}>
                    <div className="flex items-start gap-3 min-w-0">
                      <button type="button" disabled={!canSend(lead)} onClick={() => toggle(lead.id)} className="mt-1 disabled:opacity-30"
                        aria-label={isSelected ? "Deselect" : "Select"} title={canSend(lead) ? "" : lead.email ? "Already sent" : "Add an e-mail first"}>
                        {isSelected ? <CheckSquare className="w-5 h-5 text-emerald-600" /> : <Square className="w-5 h-5 text-slate-400" />}
                      </button>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-bold text-slate-900">{lead.contact_name}</span>
                          <span className={`badge ${st.cls}`}><Icon className="w-3.5 h-3.5" />{st.label}</span>
                        </div>
                        {lead.role && <p className="text-sm text-slate-600">{lead.role}</p>}
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-600 mt-1">
                          {editing === lead.id ? (
                            <form className="flex items-center gap-2" onSubmit={async (e) => {
                              e.preventDefault();
                              await onUpdate(lead.id, { email: draftEmail.trim() || null });
                              setEditing(null);
                            }}>
                              <label className="sr-only" htmlFor={`email-${lead.id}`}>E-mail</label>
                              <input id={`email-${lead.id}`} type="email" value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} autoFocus
                                placeholder="name@company.com" className="input py-1.5 w-60" />
                              <button type="submit" className="btn-primary py-1.5">Save</button>
                              <button type="button" onClick={() => setEditing(null)} className="btn-ghost py-1.5">Cancel</button>
                            </form>
                          ) : (
                            <span className="flex items-center gap-1.5">
                              <Mail className="w-4 h-4 text-slate-400" />
                              {lead.email || <em className="text-slate-400">no e-mail</em>}
                              {lead.status !== "sent" && (
                                <button type="button" onClick={() => { setEditing(lead.id); setDraftEmail(lead.email || ""); }}
                                  className="p-1 rounded text-slate-400 hover:text-blue-600" aria-label="Edit e-mail">
                                  <Pencil className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </span>
                          )}
                          {lead.phone && <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1.5 text-blue-700 hover:underline"><Phone className="w-4 h-4" />{lead.phone}</a>}
                          {lead.company && lead.company !== lead.contact_name && <span className="flex items-center gap-1.5"><Building className="w-4 h-4 text-slate-400" />{lead.company}</span>}
                          {href && <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-blue-700 hover:underline"><ExternalLink className="w-4 h-4" />source</a>}
                          {lead.sent_at && <span>· {timeAgo(lead.sent_at)}</span>}
                        </div>
                        {lead.last_error && lead.status !== "sent" && (
                          <p className={`text-sm mt-1 ${lead.status === "failed" ? "text-rose-700" : "text-indigo-700"}`}>{lead.last_error}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 self-end sm:self-center">
                      {canSend(lead) && (
                        <button type="button" disabled={!!sending} onClick={() => dispatch([lead.id])} className="btn-secondary">
                          <Send className="w-4 h-4" /> {lead.status === "queued" ? "Send" : "Retry"}
                        </button>
                      )}
                      <button type="button" onClick={() => { if (window.confirm(`Remove ${lead.contact_name}?`)) void onDelete(lead.id); }}
                        className="p-2 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Remove ${lead.contact_name}`}>
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                );
              })}
              {!syncing && visible.length === 0 && (
                <div className="card text-center py-12 px-6 text-base text-slate-600">
                  {searchLeads.length === 0
                    ? "No published e-mail addresses were found for this search. Open it in Datasets to see phone numbers and websites."
                    : "Nobody in this view."}
                </div>
              )}
            </div>

            <aside className="lg:col-span-2 card p-5 h-fit space-y-4 lg:sticky lg:top-28">
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2"><Mail className="w-5 h-5 text-blue-600" /> E-mail template</h3>
              <div>
                <label htmlFor="tpl-goal" className="label">What do you want? (for the AI draft)</label>
                <div className="flex gap-2">
                  <input id="tpl-goal" className="input" value={goal} onChange={(e) => setGoal(e.target.value)} maxLength={500}
                    placeholder="e.g. hire them for a logo design project" />
                  <button type="button" onClick={draft} disabled={drafting} className="btn-secondary shrink-0">
                    {drafting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4 text-indigo-600" />} Draft
                  </button>
                </div>
              </div>
              <div>
                <label htmlFor="tpl-subject" className="label">Subject</label>
                <input id="tpl-subject" className="input" maxLength={300} value={template.subject}
                  onChange={(e) => setTemplate((t) => ({ ...t, subject: e.target.value }))} />
              </div>
              <div>
                <label htmlFor="tpl-body" className="label">Message</label>
                <textarea id="tpl-body" rows={9} maxLength={10000} value={template.body}
                  onChange={(e) => setTemplate((t) => ({ ...t, body: e.target.value }))} className="input leading-relaxed resize-y" />
              </div>
              <p className="rounded-xl bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
                Sent by Team Magpie on your behalf. {"{name}"} is the person you're writing to, {"{sender}"} and{" "}
                {"{sender_email}"} are you, and {"{looking_for}"} is what you searched for. Replies come straight to your
                e-mail, and an opt-out line is added automatically.
              </p>
              {preview && (
                <div>
                  <span className="label">Preview for {preview.contact_name}</span>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-800 whitespace-pre-wrap">
                    <div className="text-xs text-slate-500 mb-1">From: Team Magpie · Reply-to: {sender?.email}</div>
                    <div className="font-semibold mb-2">{render(template.subject, preview, sender)}</div>
                    {render(template.body, preview, sender)}
                  </div>
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
};
