import React, { useMemo, useState } from "react";
import {
  AlertTriangle, Building, CheckCircle2, CheckSquare, Clock, ExternalLink, FlaskConical, Loader2, Mail, Pencil, Phone,
  Send, Sparkles, Square, Trash2, Users, XCircle,
} from "lucide-react";
import type { Lead, SystemStatus } from "@/types";
import { safeHref, timeAgo } from "@/lib/format";

export interface OutreachTemplate {
  subject: string;
  body: string;
}

interface LeadsViewProps {
  leads: Lead[];
  status: SystemStatus | null;
  sending: { done: number; total: number } | null;
  drafting: boolean;
  onSend: (leadIds: string[], template: OutreachTemplate) => Promise<void>;
  onDraft: (goal: string) => Promise<OutreachTemplate | null>;
  onUpdate: (leadId: string, changes: { email?: string | null }) => Promise<void>;
  onDelete: (leadId: string) => Promise<void>;
  onGoHome: () => void;
}

const DEFAULT_TEMPLATE: OutreachTemplate = {
  subject: "Quick question for {name}",
  body: "Hi {name},\n\nI came across {company} while looking for {role} and really liked what I saw.\n\nWould you be open to a short call this week to talk about working together?\n\nBest regards",
};

const render = (text: string, lead: Lead) =>
  text.split("{name}").join(lead.contact_name || "there").split("{company}").join(lead.company || "your team")
    .split("{role}").join(lead.role || "this");

const STATUS: Record<string, { label: string; cls: string; icon: React.ElementType }> = {
  queued: { label: "Not sent", cls: "text-amber-800 bg-amber-50 border-amber-200", icon: Clock },
  sent: { label: "Sent", cls: "text-emerald-800 bg-emerald-50 border-emerald-200", icon: CheckCircle2 },
  simulated: { label: "Simulated", cls: "text-indigo-800 bg-indigo-50 border-indigo-200", icon: FlaskConical },
  failed: { label: "Failed", cls: "text-rose-800 bg-rose-50 border-rose-200", icon: XCircle },
};

export const LeadsView: React.FC<LeadsViewProps> = ({ leads, status, sending, drafting, onSend, onDraft, onUpdate, onDelete, onGoHome }) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [template, setTemplate] = useState<OutreachTemplate>(DEFAULT_TEMPLATE);
  const [goal, setGoal] = useState("");
  const [filter, setFilter] = useState<"all" | "todo" | "done">("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [draftEmail, setDraftEmail] = useState("");

  const canSend = (l: Lead) => !!l.email && l.status !== "sent";
  const chosen = selected.filter((id) => leads.some((l) => l.id === id && canSend(l)));
  const preview = leads.find((l) => l.id === chosen[0]) || leads.find(canSend) || leads[0];
  const emailMode = status?.email.mode ?? "simulated";
  const withEmail = leads.filter((l) => l.email).length;

  const visible = useMemo(() => leads.filter((l) => {
    if (filter === "todo") return l.status === "queued" || l.status === "failed";
    if (filter === "done") return l.status === "sent" || l.status === "simulated";
    return true;
  }), [leads, filter]);

  const toggle = (id: string) => setSelected((prev) => (prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]));
  const dispatch = async (ids: string[]) => {
    await onSend(ids, template);
    setSelected((prev) => prev.filter((id) => !ids.includes(id)));
  };
  const draft = async () => {
    const t = await onDraft(goal);
    if (t) setTemplate(t);
  };

  if (leads.length === 0) {
    return (
      <div className="w-full max-w-3xl mx-auto px-4 py-10">
        <div className="card p-12 text-center">
          <div className="w-16 h-16 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mx-auto mb-4">
            <Users className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">No leads yet</h2>
          <p className="text-base text-slate-600 mb-6">Open a dataset, select rows and click “Add selected to outreach”.</p>
          <button type="button" onClick={onGoHome} className="btn-primary">Start a collection</button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1300px] mx-auto px-4 py-8">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-5">
        <div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Leads & Outreach</h1>
          <p className="text-base text-slate-600 mt-1">
            {leads.length} leads · {withEmail} with an e-mail ({leads.length ? Math.round((withEmail / leads.length) * 100) : 0}%) ·
            {" "}{leads.filter((l) => l.phone).length} with a phone
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setSelected(leads.filter((l) => canSend(l) && l.status !== "simulated").map((l) => l.id))} className="btn-secondary">
            Select all with e-mail
          </button>
          <button type="button" disabled={!chosen.length || !!sending} onClick={() => dispatch(chosen)} className="btn-success">
            {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {sending ? `Sending ${sending.done}/${sending.total}…` : `${emailMode === "simulated" ? "Simulate" : "Send"} (${chosen.length})`}
          </button>
        </div>
      </div>

      {emailMode === "simulated" ? (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <AlertTriangle className="w-5 h-5 shrink-0 text-amber-600" />
          E-mail sending isn't configured on the server, so sends are only simulated.
        </div>
      ) : (
        <div className="mb-5 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
          <Mail className="w-5 h-5 shrink-0 text-emerald-600" />
          E-mails go out from {status?.email.from} and replies come to {status?.email.reply_to}.
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        <div className="lg:col-span-3 space-y-3">
          <div className="flex flex-wrap gap-2 mb-1" role="tablist" aria-label="Filter leads">
            {([["all", `All (${leads.length})`], ["todo", `To send (${leads.filter((l) => l.status === "queued" || l.status === "failed").length})`],
              ["done", `Sent (${leads.filter((l) => l.status === "sent" || l.status === "simulated").length})`]] as const).map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={filter === id} onClick={() => setFilter(id)}
                className={`px-4 py-1.5 rounded-full text-sm font-semibold ${filter === id ? "bg-blue-600 text-white" : "bg-white text-slate-700 border border-slate-200 hover:bg-slate-50"}`}>
                {label}
              </button>
            ))}
          </div>

          {visible.map((lead) => {
            const st = STATUS[lead.status] || STATUS.queued;
            const Icon = st.icon;
            const isSelected = chosen.includes(lead.id);
            const href = safeHref(lead.source_url);
            return (
              <div key={lead.id} className={`card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${isSelected ? "ring-2 ring-emerald-500" : ""}`}>
                <div className="flex items-start gap-3 min-w-0">
                  <button type="button" disabled={!canSend(lead)} onClick={() => toggle(lead.id)} className="mt-1 disabled:opacity-30"
                    aria-label={isSelected ? "Deselect lead" : "Select lead"} title={canSend(lead) ? "" : lead.email ? "Already sent" : "Add an e-mail first"}>
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
                          {lead.email || <em className="text-slate-400">no e-mail published</em>}
                          {lead.status !== "sent" && (
                            <button type="button" onClick={() => { setEditing(lead.id); setDraftEmail(lead.email || ""); }}
                              className="p-1 rounded text-slate-400 hover:text-blue-600" aria-label="Edit e-mail">
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </span>
                      )}
                      {lead.phone && <a href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-1.5 text-blue-700 hover:underline"><Phone className="w-4 h-4" />{lead.phone}</a>}
                      {lead.company && <span className="flex items-center gap-1.5"><Building className="w-4 h-4 text-slate-400" />{lead.company}</span>}
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
          {visible.length === 0 && <div className="card text-center py-12 text-base text-slate-500">No leads in this view.</div>}
        </div>

        <aside className="lg:col-span-2 card p-5 h-fit space-y-4 lg:sticky lg:top-28">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2"><Mail className="w-5 h-5 text-blue-600" /> E-mail template</h2>
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
            <input id="tpl-subject" className="input" maxLength={300} value={template.subject} onChange={(e) => setTemplate((t) => ({ ...t, subject: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="tpl-body" className="label">Message</label>
            <textarea id="tpl-body" rows={9} maxLength={10000} value={template.body} onChange={(e) => setTemplate((t) => ({ ...t, body: e.target.value }))}
              className="input leading-relaxed resize-y" />
          </div>
          <p className="rounded-xl bg-blue-50 border border-blue-200 p-3 text-sm text-blue-900">
            {"{name}"}, {"{company}"} and {"{role}"} are filled in for each lead. An opt-out line is added automatically.
          </p>
          {preview && (
            <div>
              <span className="label">Preview for {preview.contact_name}</span>
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-sm text-slate-800 whitespace-pre-wrap">
                <div className="font-semibold mb-2">{render(template.subject, preview)}</div>
                {render(template.body, preview)}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};
