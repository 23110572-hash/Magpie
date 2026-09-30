import React, { useEffect, useMemo, useState } from "react";
import {
  Building2, CheckSquare, Database, Download, ExternalLink, Eye, FileJson, FileText, Globe, LayoutGrid, Loader2,
  Mail, MapPin, Phone, Plus, Search, Send, Square, Table2, Trash2, X,
} from "lucide-react";
import type { Column, DataRecord, DatasetDetail, DatasetSummary } from "@/types";
import { countryLabel, intentLabel, placeText } from "@/types";
import { api } from "@/lib/api";
import { formatDateTime, hostOf, safeHref, timeAgo } from "@/lib/format";

interface DatasetsViewProps {
  datasets: DatasetSummary[];
  selectedId: string | null;
  detail: DatasetDetail | null;
  loading: boolean;
  onSelect: (id: string | null) => void;
  onAddLeads: (recordIds: string[]) => Promise<void>;
  onExport: (dataset: DatasetSummary, format: "csv" | "json") => void;
  onDelete: (dataset: DatasetSummary) => void;
  onGoHome: () => void;
}

type View = "table" | "cards";

const columnValue = (record: DataRecord, key: string): string => {
  const d = record.details || {};
  const value = (d.columns || {})[key] ?? (d.fields || {})[key] ?? d[key];
  if (value === null || value === undefined || value === "") return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
};

export const DatasetsView: React.FC<DatasetsViewProps> = ({
  datasets, selectedId, detail, loading, onSelect, onAddLeads, onExport, onDelete, onGoHome,
}) => {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [needEmail, setNeedEmail] = useState(false);
  const [needPhone, setNeedPhone] = useState(false);
  const [view, setView] = useState<View>("table");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [inspecting, setInspecting] = useState<DataRecord | null>(null);
  const [adding, setAdding] = useState(false);

  const active = detail && detail.id === selectedId ? detail : null;
  const summary: DatasetSummary | null = datasets.find((d) => d.id === selectedId) || active;
  const records = useMemo(() => active?.records ?? [], [active]);
  const summaryColumns = summary?.columns;
  const columns: Column[] = useMemo(
    () => (active?.columns?.length ? active.columns : summaryColumns ?? []),
    [active, summaryColumns],
  );

  const selectDataset = (id: string | null) => {
    setQuery("");
    setSource("all");
    setNeedEmail(false);
    setNeedPhone(false);
    setSelected(new Set());
    onSelect(id);
  };

  const sources = useMemo(() => {
    const counts = new Map<string, number>();
    records.forEach((r) => counts.set(r.source || "Web", (counts.get(r.source || "Web") || 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter((r) => {
      if (source !== "all" && (r.source || "Web") !== source) return false;
      if (needEmail && !r.email) return false;
      if (needPhone && !r.phone) return false;
      if (!q) return true;
      const hay = [r.title, r.company, r.location, r.email, r.source, r.details?.description, r.details?.reason,
        ...columns.map((c) => columnValue(r, c.key))].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }, [records, query, source, needEmail, needPhone, columns]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allVisibleSelected = filtered.length > 0 && filtered.every((r) => selected.has(r.id));
  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((r) => next.delete(r.id));
      else filtered.forEach((r) => next.add(r.id));
      return next;
    });

  const addLeads = async (ids: string[]) => {
    if (!ids.length) return;
    setAdding(true);
    try {
      await onAddLeads(ids);
      setSelected(new Set());
    } finally {
      setAdding(false);
    }
  };

  if (datasets.length === 0) {
    return (
      <div className="w-full max-w-3xl mx-auto px-4 py-10">
        <div className="card p-12 text-center">
          <div className="w-16 h-16 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 mx-auto mb-4">
            <Database className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 mb-2">No datasets yet</h2>
          <p className="text-base text-slate-600 mb-6">
            Tell Magpie what you need on the Home page - in any words. Every run becomes a clean, source-backed dataset here.
          </p>
          <button type="button" onClick={onGoHome} className="btn-primary"><Plus className="w-5 h-5" /> Start a collection</button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[1400px] mx-auto px-4 py-8">
      <div className="mb-4 print:hidden">
        <h1 className="text-3xl font-black text-slate-900 tracking-tight">Datasets</h1>
        <p className="text-base text-slate-600 mt-1">
          {datasets.length} {datasets.length === 1 ? "search" : "searches"} saved. Pick one to see its results.
        </p>
      </div>

      {/* One card per search, in a horizontal bar */}
      <div className="flex gap-3 overflow-x-auto snap-x pb-3 mb-6 -mx-1 px-1 print:hidden" role="tablist" aria-label="Your datasets">
        {datasets.map((d) => {
          const isActive = d.id === selectedId;
          return (
            <button key={d.id} type="button" role="tab" aria-selected={isActive}
              onClick={() => selectDataset(isActive ? null : d.id)} title={formatDateTime(d.created_at)}
              className={`snap-start shrink-0 w-72 text-left rounded-2xl border p-4 transition-all ${
                isActive
                  ? "bg-blue-600 border-blue-600 text-white shadow-lg shadow-blue-600/25"
                  : "bg-white border-slate-200 text-slate-900 shadow-sm hover:border-blue-300 hover:shadow-md"
              }`}>
              <div className="flex items-center justify-between gap-2 mb-2">
                <span className={`badge ${isActive ? "bg-white/15 border-white/30 text-white" : "bg-blue-50 text-blue-700 border-blue-200"}`}>
                  {intentLabel(d.intent) || "Dataset"}
                </span>
                <span className={`text-xs ${isActive ? "text-blue-100" : "text-slate-500"}`}>{timeAgo(d.created_at)}</span>
              </div>
              <div className="text-base font-bold leading-snug line-clamp-2 min-h-[3rem]">{d.label || d.name}</div>
              <div className={`mt-2 text-sm ${isActive ? "text-blue-100" : "text-slate-600"}`}>
                {d.row_count} results · {d.coverage?.with_email ?? 0} e-mails · {d.coverage?.with_phone ?? 0} phones
              </div>
            </button>
          );
        })}
      </div>

      {!selectedId ? (
        <div className="card p-10 text-center print:hidden">
          <div className="w-14 h-14 rounded-2xl bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 mx-auto mb-3">
            <Database className="w-7 h-7" />
          </div>
          <p className="text-lg font-semibold text-slate-900">Select a dataset above to explore its results</p>
          <p className="text-base text-slate-600 mt-1">You can search, filter, export and add people to outreach from there.</p>
        </div>
      ) : summary && (
        <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-5 print:mb-2">
          <div className="min-w-0">
            <h2 className="text-2xl sm:text-3xl font-black text-slate-900 tracking-tight">{summary.label || summary.name}</h2>
            <div className="flex flex-wrap items-center gap-2 mt-2 text-sm text-slate-600">
              {summary.intent && <span className="badge bg-blue-50 text-blue-700 border-blue-200">{intentLabel(summary.intent)}</span>}
              {summary.country && <span className="badge bg-slate-50 text-slate-700 border-slate-200">{countryLabel(summary.country)}</span>}
              {placeText(summary.place) && <span className="flex items-center gap-1"><MapPin className="w-4 h-4" />{placeText(summary.place)}</span>}
              <span>· {summary.row_count} results</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <button type="button" onClick={() => onExport(summary, "csv")} className="btn-secondary"><Download className="w-4 h-4 text-emerald-600" /> CSV</button>
            <button type="button" onClick={() => onExport(summary, "json")} className="btn-secondary"><FileJson className="w-4 h-4 text-indigo-600" /> JSON</button>
            <button type="button" onClick={() => window.print()} disabled={!active} className="btn-secondary"><FileText className="w-4 h-4 text-blue-600" /> PDF</button>
            <button type="button" onClick={() => onDelete(summary)} className="btn-secondary"><Trash2 className="w-4 h-4 text-rose-500" /> Delete</button>
            <button type="button" onClick={() => selectDataset(null)} className="btn-ghost" aria-label="Close this dataset">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
      )}

      {!selectedId ? null : loading && !active ? (
        <div className="flex items-center justify-center gap-2 py-24 text-base text-slate-500"><Loader2 className="w-5 h-5 animate-spin" /> Loading rows…</div>
      ) : !active ? null : records.length === 0 ? (
        <div className="card p-10 text-center max-w-xl mx-auto my-8">
          <h2 className="text-xl font-bold text-slate-900 mb-2">No rows matched</h2>
          <p className="text-base text-slate-600 mb-5">Nothing passed the AI check for “{active.prompt}”. Try Deep mode or reword it.</p>
          <button type="button" onClick={onGoHome} className="btn-primary">New collection</button>
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3 mb-4 print:hidden">
            <div className="flex flex-wrap gap-2 items-center">
              <label className="relative w-full sm:w-80">
                <span className="sr-only">Search rows</span>
                <Search className="w-5 h-5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, place, skills…" className="input pl-10" />
              </label>
              <label className="sr-only" htmlFor="source-filter">Source</label>
              <select id="source-filter" value={source} onChange={(e) => setSource(e.target.value)} className="input w-auto">
                <option value="all">All sources ({records.length})</option>
                {sources.map(([name, count]) => <option key={name} value={name}>{name} ({count})</option>)}
              </select>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer px-2">
                <input type="checkbox" checked={needEmail} onChange={(e) => setNeedEmail(e.target.checked)} className="w-4 h-4 accent-blue-600" /> Has e-mail
              </label>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer px-2">
                <input type="checkbox" checked={needPhone} onChange={(e) => setNeedPhone(e.target.checked)} className="w-4 h-4 accent-blue-600" /> Has phone
              </label>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-slate-600">Showing <strong className="text-slate-900">{filtered.length}</strong> of {records.length}</span>
              <div className="flex rounded-xl border border-slate-200 bg-white p-1" role="group" aria-label="View">
                <button type="button" onClick={() => setView("table")} aria-pressed={view === "table"}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 ${view === "table" ? "bg-slate-900 text-white" : "text-slate-600"}`}>
                  <Table2 className="w-4 h-4" /> Table
                </button>
                <button type="button" onClick={() => setView("cards")} aria-pressed={view === "cards"}
                  className={`px-3 py-1.5 rounded-lg text-sm font-semibold flex items-center gap-1.5 ${view === "cards" ? "bg-slate-900 text-white" : "text-slate-600"}`}>
                  <LayoutGrid className="w-4 h-4" /> Cards
                </button>
              </div>
            </div>
          </div>

          {/* Selection bar */}
          <div className="flex flex-wrap items-center gap-2 mb-4 print:hidden">
            <button type="button" disabled={!selected.size || adding} onClick={() => addLeads([...selected])} className="btn-success">
              {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Add selected to outreach ({selected.size})
            </button>
          </div>

          {view === "table" ? (
            <div className="card overflow-x-auto print:hidden">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="p-3 w-10">
                      <button type="button" onClick={toggleAllVisible} aria-label={allVisibleSelected ? "Deselect all" : "Select all"}>
                        {allVisibleSelected ? <CheckSquare className="w-5 h-5 text-blue-600" /> : <Square className="w-5 h-5" />}
                      </button>
                    </th>
                    <th className="p-3 font-semibold min-w-[220px]">Name</th>
                    <th className="p-3 font-semibold min-w-[160px]">Organisation</th>
                    <th className="p-3 font-semibold min-w-[150px]">Location</th>
                    {columns.map((c) => <th key={c.key} className="p-3 font-semibold min-w-[140px]">{c.label}</th>)}
                    <th className="p-3 font-semibold min-w-[200px]">E-mail</th>
                    <th className="p-3 font-semibold min-w-[150px]">Phone</th>
                    <th className="p-3 font-semibold">Website</th>
                    <th className="p-3 font-semibold">Source</th>
                    <th className="p-3 sr-only">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const href = safeHref(r.source_url);
                    const site = safeHref(r.website);
                    return (
                      <tr key={r.id} className={`border-t border-slate-100 align-top ${selected.has(r.id) ? "bg-emerald-50/50" : "hover:bg-slate-50/60"}`}>
                        <td className="p-3">
                          <button type="button" onClick={() => toggle(r.id)} aria-label={selected.has(r.id) ? "Deselect row" : "Select row"}>
                            {selected.has(r.id) ? <CheckSquare className="w-5 h-5 text-emerald-600" /> : <Square className="w-5 h-5 text-slate-400" />}
                          </button>
                        </td>
                        <td className="p-3">
                          <div className="font-semibold text-slate-900">{r.title}</div>
                          {r.details?.reason && <div className="text-xs text-slate-500 mt-0.5">{String(r.details.reason)}</div>}
                        </td>
                        <td className="p-3 text-slate-700">{r.company}</td>
                        <td className="p-3 text-slate-700">{r.location}</td>
                        {columns.map((c) => <td key={c.key} className="p-3 text-slate-700">{columnValue(r, c.key)}</td>)}
                        <td className="p-3">{r.email ? <a className="text-blue-700 hover:underline break-all" href={`mailto:${r.email}`}>{r.email}</a> : <span className="text-slate-400">-</span>}</td>
                        <td className="p-3 whitespace-nowrap">{r.phone ? <a className="text-blue-700 hover:underline" href={`tel:${r.phone.replace(/[^\d+]/g, "")}`}>{r.phone}</a> : <span className="text-slate-400">-</span>}</td>
                        <td className="p-3">{site ? <a className="text-blue-700 hover:underline" href={site} target="_blank" rel="noopener noreferrer">{hostOf(site)}</a> : <span className="text-slate-400">-</span>}</td>
                        <td className="p-3 whitespace-nowrap">
                          {href ? <a className="text-slate-700 hover:text-blue-700 flex items-center gap-1" href={href} target="_blank" rel="noopener noreferrer">{r.source}<ExternalLink className="w-3.5 h-3.5" /></a> : r.source}
                        </td>
                        <td className="p-3">
                          <button type="button" onClick={() => setInspecting(r)} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100" aria-label={`Provenance of ${r.title}`}>
                            <Eye className="w-5 h-5" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 print:hidden">
              {filtered.map((r) => {
                const href = safeHref(r.source_url);
                const site = safeHref(r.website);
                return (
                  <article key={r.id} className={`card p-5 flex flex-col justify-between ${selected.has(r.id) ? "ring-2 ring-emerald-500" : ""}`}>
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-2">
                        <span className="badge bg-blue-50 text-blue-700 border-blue-200 truncate max-w-[60%]">{r.source}</span>
                      </div>
                      <h2 className="text-lg font-bold text-slate-900 line-clamp-2">{r.title}</h2>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-slate-600 mt-1.5">
                        {r.company && <span className="flex items-center gap-1"><Building2 className="w-4 h-4 text-slate-400" />{r.company}</span>}
                        {r.location && <span className="flex items-center gap-1"><MapPin className="w-4 h-4 text-slate-400" />{r.location}</span>}
                      </div>
                      {columns.some((c) => columnValue(r, c.key)) && (
                        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                          {columns.filter((c) => columnValue(r, c.key)).map((c) => (
                            <React.Fragment key={c.key}>
                              <dt className="text-slate-500">{c.label}</dt>
                              <dd className="text-slate-800">{columnValue(r, c.key)}</dd>
                            </React.Fragment>
                          ))}
                        </dl>
                      )}
                      {r.details?.reason && <p className="text-sm text-slate-500 mt-2 italic">{String(r.details.reason)}</p>}
                      <div className="mt-3 space-y-1 text-sm">
                        {r.email && <a href={`mailto:${r.email}`} className="flex items-center gap-2 text-blue-700 hover:underline break-all"><Mail className="w-4 h-4" />{r.email}</a>}
                        {r.phone && <a href={`tel:${r.phone.replace(/[^\d+]/g, "")}`} className="flex items-center gap-2 text-blue-700 hover:underline"><Phone className="w-4 h-4" />{r.phone}</a>}
                        {site && <a href={site} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-blue-700 hover:underline"><Globe className="w-4 h-4" />{hostOf(site)}</a>}
                      </div>
                    </div>
                    <div className="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1">
                        <button type="button" onClick={() => setInspecting(r)} className="p-2 rounded-lg text-slate-500 hover:bg-slate-100" aria-label="Provenance"><Eye className="w-5 h-5" /></button>
                        {href && <a href={href} target="_blank" rel="noopener noreferrer" className="p-2 rounded-lg text-slate-500 hover:bg-blue-50 hover:text-blue-700" aria-label="Open source"><ExternalLink className="w-5 h-5" /></a>}
                      </div>
                      <button type="button" onClick={() => toggle(r.id)} className={selected.has(r.id) ? "btn-success" : "btn-secondary"}>
                        {selected.has(r.id) ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />} Select
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {/* Print / PDF */}
          <table className="hidden print:table w-full text-[11px] border-collapse">
            <thead>
              <tr className="text-left border-b border-slate-400">
                <th className="py-1 pr-2">#</th><th className="py-1 pr-2">Name</th><th className="py-1 pr-2">Organisation</th>
                <th className="py-1 pr-2">Location</th>{columns.map((c) => <th key={c.key} className="py-1 pr-2">{c.label}</th>)}
                <th className="py-1 pr-2">E-mail</th><th className="py-1 pr-2">Phone</th><th className="py-1">Source URL</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id} className="border-b border-slate-200 align-top">
                  <td className="py-1 pr-2">{i + 1}</td><td className="py-1 pr-2 font-semibold">{r.title}</td><td className="py-1 pr-2">{r.company}</td>
                  <td className="py-1 pr-2">{r.location}</td>{columns.map((c) => <td key={c.key} className="py-1 pr-2">{columnValue(r, c.key)}</td>)}
                  <td className="py-1 pr-2">{r.email}</td><td className="py-1 pr-2">{r.phone}</td><td className="py-1 break-all">{r.source_url}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {inspecting && <SnapshotModal record={inspecting} onClose={() => setInspecting(null)} />}
    </div>
  );
};

const SnapshotModal: React.FC<{ record: DataRecord; onClose: () => void }> = ({ record, onClose }) => {
  const [full, setFull] = useState<DataRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<DataRecord>(`/api/records/${record.id}`)
      .then((r) => { if (alive) setFull(r); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [record.id, onClose]);

  const href = safeHref(record.source_url);
  const details = full?.details || record.details;
  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 print:hidden">
      <div role="dialog" aria-modal="true" aria-labelledby="snapshot-title" onClick={(e) => e.stopPropagation()}
        className="card max-w-3xl w-full max-h-[90vh] overflow-y-auto p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100 mb-4">
          <div className="min-w-0">
            <h3 id="snapshot-title" className="text-lg font-bold text-slate-900">Where this row came from</h3>
            <p className="text-sm text-slate-500 truncate">{[record.title, record.company].filter(Boolean).join(" - ")}</p>
          </div>
          <button type="button" onClick={onClose} autoFocus className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <dl className="grid grid-cols-1 sm:grid-cols-[170px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-semibold text-slate-700">Source</dt><dd>{record.source}</dd>
          <dt className="font-semibold text-slate-700">Source URL</dt>
          <dd>{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-700 hover:underline break-all">{href}</a> : "-"}</dd>
          <dt className="font-semibold text-slate-700">Collected</dt><dd>{formatDateTime(record.created_at)} ({timeAgo(record.created_at)})</dd>
          {details.reason && (<><dt className="font-semibold text-slate-700">Why it matched</dt><dd>{String(details.reason)}</dd></>)}
          {details.contact_source && (<><dt className="font-semibold text-slate-700">Contact found on</dt><dd className="break-all">{String(details.contact_source)}</dd></>)}
          {!!details.also_seen_at?.length && (<><dt className="font-semibold text-slate-700">Also seen at</dt><dd className="break-all">{details.also_seen_at.join(" · ")}</dd></>)}
        </dl>
        <div className="mt-4">
          <span className="text-sm font-semibold text-slate-700 block mb-1">Structured fields</span>
          <pre className="p-3 rounded-xl bg-slate-50 text-slate-800 font-mono text-xs overflow-x-auto max-h-52 border border-slate-200 whitespace-pre-wrap break-words">
            {JSON.stringify(details, null, 2)}
          </pre>
        </div>
        <div className="mt-4">
          <span className="text-sm font-semibold text-slate-700 block mb-1">Raw snapshot (exact data from the source)</span>
          <pre className="p-4 rounded-xl bg-slate-900 text-slate-100 font-mono text-xs overflow-x-auto max-h-72 border border-slate-800 whitespace-pre-wrap break-words">
            {error ? `Could not load snapshot: ${error}` : full ? full.raw_snapshot || "(empty)" : "Loading…"}
          </pre>
        </div>
      </div>
    </div>
  );
};
