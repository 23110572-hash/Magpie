export type Mode = "Fast" | "Balanced" | "Deep";
export type Country = "IN" | "US" | "EU";
export type Intent = "people" | "jobs" | "companies" | "local_businesses" | "events" | "news" | "market" | "other";
export type Tab = "home" | "datasets" | "leads" | "history" | "settings";

export const COUNTRIES: { code: Country; label: string }[] = [
  { code: "IN", label: "India" },
  { code: "US", label: "United States" },
  { code: "EU", label: "European Union" },
];
export const countryLabel = (code?: string | null) => COUNTRIES.find((c) => c.code === code)?.label ?? code ?? "";

export const INTENT_LABELS: Record<Intent, string> = {
  people: "People",
  jobs: "Jobs",
  companies: "Companies",
  local_businesses: "Local businesses",
  events: "Events & sponsors",
  news: "News",
  market: "Market data",
  other: "Other",
};
export const intentLabel = (intent?: string | null) =>
  (intent && INTENT_LABELS[intent as Intent]) || (intent ? intent.replace(/_/g, " ") : "");

export interface User {
  id: string;
  email: string;
  name: string;
  created_at?: string | null;
}

export interface Place {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  country_code?: string | null;
  scope?: string;
  aliases?: string[];
}

export interface Column {
  key: string;
  label: string;
}

export interface Coverage {
  total: number;
  with_email: number;
  with_phone: number;
  with_website: number;
  with_any_contact: number;
}

export interface RunSpec {
  corrected_prompt?: string;
  understood_as?: string;
  intent?: Intent;
  alternatives?: { intent: Intent; label: string }[];
  entity?: string;
  place?: Place;
  cover_cities?: string[];
  columns?: Column[];
  sources?: string[];
  skipped_sources?: { source: string; reason: string }[];
  planner?: string;
  planner_note?: string | null;
  market_label?: string;
}

export interface RunStats {
  sources?: Record<string, { found: number; error?: string }>;
  web_results?: number;
  direct_results?: number;
  triage?: Record<string, number>;
  pages?: { opened?: number; read?: number; entries?: number; blocked?: number; failed?: number };
  candidates?: number;
  checked?: number;
  kept?: number;
  rejected?: number;
  unchecked?: number;
  duplicates_merged?: number;
  contacts?: { checked?: number; emails_found?: number; phones_found?: number };
  coverage?: Coverage;
  llm?: { calls?: number; prompt_tokens?: number; completion_tokens?: number; cost_usd?: number };
  dataset_id?: string;
  dataset_name?: string;
  deduplicated_count?: number;
  duration_seconds?: number;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  prompt: string;
  mode?: string | null;
  country?: string | null;
  intent_override?: string | null;
  status: string;
  step: string;
  progress: number;
  eta_seconds: number;
  message?: string | null;
  spec: RunSpec;
  stats: RunStats;
  created_at?: string | null;
  updated_at?: string | null;
  finished_at?: string | null;
}

export interface RecordDetails {
  description?: string;
  snippet?: string;
  reason?: string;
  fields?: Record<string, unknown>;
  columns?: Record<string, unknown>;
  remote?: boolean | null;
  salary?: string;
  emails?: string[];
  phones?: string[];
  also_seen_at?: string[];
  contact_source?: string;
  category?: string;
  rating?: number;
  [key: string]: unknown;
}

export interface DataRecord {
  id: string;
  dataset_id?: string | null;
  title: string;
  company?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  score?: number | null;
  source?: string | null;
  source_url?: string | null;
  details: RecordDetails;
  created_at?: string | null;
  raw_snapshot?: string | null;
}

export interface DatasetSummary {
  id: string;
  workflow_run_id?: string | null;
  name: string;
  category?: string | null;
  intent?: string | null;
  label?: string | null;
  country?: string | null;
  place?: Place | null;
  columns?: Column[];
  coverage?: Partial<Coverage> | null;
  row_count: number;
  created_at?: string | null;
}

export interface DatasetDetail extends DatasetSummary {
  prompt?: string | null;
  records: DataRecord[];
}

export interface Lead {
  id: string;
  record_id?: string | null;
  dataset_id?: string | null;
  contact_name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  role?: string | null;
  website?: string | null;
  source_url?: string | null;
  status: string;
  template_subject?: string | null;
  template_body?: string | null;
  last_error?: string | null;
  message_id?: string | null;
  created_at?: string | null;
  sent_at?: string | null;
}

export interface SystemStatus {
  llm: { enabled: boolean; model: string | null };
  keys: Record<string, boolean>;
  sources: { key: string; label: string; description: string; available: boolean }[];
  email: { mode: "relay" | "direct" | "simulated"; from: string | null; reply_to: string };
}

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];
export const isTerminal = (status?: string | null) => !!status && TERMINAL_STATUSES.includes(status);

/** Something a guest tried to do; it is carried out right after they sign in. */
export interface PendingAction {
  run?: { prompt: string; mode: Mode; country: Country };
  tab?: Tab;
}

export const placeText = (place?: Place | null) =>
  place ? [place.city, place.region, place.country].filter(Boolean).join(", ") : "";
