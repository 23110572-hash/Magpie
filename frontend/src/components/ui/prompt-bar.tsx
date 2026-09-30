import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, ChevronDown, Globe, Lightbulb, Loader2, Mic, Scale, Zap, type LucideIcon } from "lucide-react";
import { COUNTRIES, type Country, type Mode } from "@/types";

export interface PromptBarProps {
  /** Resolve to false when the request could not start, so the text is put back in the box. */
  onSubmit: (value: string, mode: Mode, country: Country) => Promise<boolean> | boolean | void;
  isLoading?: boolean;
}

const MODES: { id: Mode; icon: LucideIcon; label: string; hint: string }[] = [
  { id: "Fast", icon: Zap, label: "Fast", hint: "Quick scan, fewer pages (~30s)" },
  { id: "Balanced", icon: Scale, label: "Balanced", hint: "Reads pages & finds contacts (~1-2 min)" },
  { id: "Deep", icon: Lightbulb, label: "Deep", hint: "More queries, cities and pages (~3 min)" },
];

const SUGGESTIONS = [
  "i need devloper in chandigarh",
  "graphic designers from india",
  "digital marketing agencies in mumbai with emails",
  "react js jobs in bangalore for freshers",
];

const COUNTRY_KEY = "magpie.country";

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function initialCountry(): Country {
  try {
    const saved = localStorage.getItem(COUNTRY_KEY);
    if (saved === "IN" || saved === "US" || saved === "EU") return saved;
  } catch {
    // ignore
  }
  return "IN";
}

export default function PromptBar({ onSubmit, isLoading = false }: PromptBarProps) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState<"mode" | "country" | null>(null);
  const [mode, setMode] = useState<Mode>("Balanced");
  const [country, setCountry] = useState<Country>(initialCountry);
  const [recording, setRecording] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(null);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
      recognitionRef.current?.stop();
    };
  }, []);

  const chooseCountry = (code: Country) => {
    setCountry(code);
    setOpen(null);
    try {
      localStorage.setItem(COUNTRY_KEY, code);
    } catch {
      // ignore
    }
  };

  const submit = async () => {
    const text = value.trim();
    if (text.length < 3 || isLoading) return;
    setValue(""); // clear like a chat box as soon as it is sent
    const started = await onSubmit(text, mode, country);
    if (started === false) setValue((current) => current || text); // keep it if it didn't start
  };

  const toggleRecording = () => {
    setMicError(null);
    if (recording) {
      recognitionRef.current?.stop();
      setRecording(false);
      return;
    }
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) {
      setMicError("Voice input is not supported in this browser.");
      return;
    }
    try {
      const recognition = new Recognition();
      recognition.lang = country === "IN" ? "en-IN" : "en-US";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript || "";
        setValue((prev) => (prev ? `${prev} ${transcript}` : transcript));
      };
      recognition.onerror = () => setRecording(false);
      recognition.onend = () => setRecording(false);
      recognitionRef.current = recognition;
      recognition.start();
      setRecording(true);
    } catch {
      setRecording(false);
    }
  };

  const ModeIcon = MODES.find((m) => m.id === mode)?.icon ?? Scale;
  const canSubmit = value.trim().length >= 3 && !isLoading;
  const countryName = COUNTRIES.find((c) => c.code === country)?.label ?? "India";

  return (
    <div ref={rootRef} className="prompt-bar-glow relative w-full max-w-[820px] rounded-[26px] p-[2px] shadow-xl">
      <style>{`
        @property --pb-angle { syntax: '<angle>'; inherits: false; initial-value: 0deg; }
        .prompt-bar-glow {
          background-image: conic-gradient(from var(--pb-angle), transparent 0deg, transparent 280deg,
            #1a6ef4 310deg, #38bdf8 330deg, #6366f1 350deg, transparent 360deg);
          animation: pb-rotate 6s linear infinite;
        }
        @keyframes pb-rotate { to { --pb-angle: 360deg; } }
      `}</style>
      <div className="rounded-[24px] bg-white p-5 pb-4 border border-slate-200/90">
        <label htmlFor="magpie-prompt" className="sr-only">Describe the data you need</label>
        <textarea id="magpie-prompt" value={value} onChange={(e) => setValue(e.target.value)} rows={2} maxLength={2000}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="Describe what you're looking for..."
          className="mb-3 w-full resize-none bg-transparent text-lg sm:text-xl text-slate-900 placeholder:text-slate-400 focus:outline-none leading-relaxed" />

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-2">
            {/* Country */}
            <div className="relative">
              <button type="button" aria-haspopup="listbox" aria-expanded={open === "country"}
                onClick={() => setOpen(open === "country" ? null : "country")}
                className="flex items-center gap-2 rounded-xl bg-blue-50 px-3.5 py-2 text-sm font-semibold text-blue-800 border border-blue-200 hover:bg-blue-100"
                title="Which market to search">
                <Globe className="w-4 h-4" /> {countryName} <ChevronDown className="w-4 h-4" />
              </button>
              {open === "country" && (
                <div role="listbox" aria-label="Market" className="absolute left-0 bottom-14 z-50 w-64 card p-1.5 shadow-2xl">
                  {COUNTRIES.map((c) => (
                    <button key={c.code} type="button" role="option" aria-selected={c.code === country}
                      onClick={() => chooseCountry(c.code)}
                      className={`flex w-full items-center justify-between rounded-xl px-3.5 py-2.5 text-sm ${
                        c.code === country ? "bg-blue-50 text-blue-800 font-semibold" : "text-slate-700 hover:bg-slate-50"
                      }`}>
                      {c.label} {c.code === country && <Check className="w-4 h-4" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* Mode */}
            <div className="relative">
              <button type="button" aria-haspopup="listbox" aria-expanded={open === "mode"}
                onClick={() => setOpen(open === "mode" ? null : "mode")}
                className="flex items-center gap-2 rounded-xl bg-slate-100 px-3.5 py-2 text-sm font-semibold text-slate-800 border border-slate-200 hover:bg-slate-200/70">
                <ModeIcon className="w-4 h-4 text-blue-600" /> {mode} <ChevronDown className="w-4 h-4 text-slate-500" />
              </button>
              {open === "mode" && (
                <div role="listbox" aria-label="Depth" className="absolute left-0 bottom-14 z-50 w-80 card p-1.5 shadow-2xl">
                  {MODES.map(({ id, icon: Icon, label, hint }) => (
                    <button key={id} type="button" role="option" aria-selected={id === mode}
                      onClick={() => {
                        setMode(id);
                        setOpen(null);
                      }}
                      className={`flex w-full items-start gap-3 rounded-xl px-3.5 py-2.5 text-left ${
                        id === mode ? "bg-blue-50 text-blue-800" : "text-slate-700 hover:bg-slate-50"
                      }`}>
                      <Icon className="w-4 h-4 mt-1" />
                      <span>
                        <span className="block text-sm font-semibold">{label}</span>
                        <span className="block text-xs text-slate-500">{hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button type="button" onClick={toggleRecording} aria-pressed={recording}
              aria-label={recording ? "Stop voice input" : "Voice input"}
              className={`flex h-11 w-11 items-center justify-center rounded-xl transition-colors ${
                recording ? "text-red-600 bg-red-100 animate-pulse" : "text-slate-500 hover:text-slate-900 hover:bg-slate-100"
              }`}>
              <Mic className="w-5 h-5" />
            </button>
            <button type="button" onClick={() => void submit()} disabled={!canSubmit} aria-label="Start collecting"
              className={`flex h-11 w-11 items-center justify-center rounded-xl shadow-md transition-all ${
                canSubmit
                  ? "bg-gradient-to-r from-blue-600 to-indigo-600 text-white hover:scale-105 active:scale-95 shadow-blue-500/25"
                  : "bg-slate-100 text-slate-400 cursor-not-allowed border border-slate-200"
              }`}>
              {isLoading ? <Loader2 className="w-5 h-5 animate-spin text-slate-500" /> : <ArrowUp className="w-5 h-5" />}
            </button>
          </div>
        </div>
        {micError && <p className="mt-2 text-sm text-rose-600" role="alert">{micError}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => setValue(s)}
              className="text-xs px-3 py-1.5 rounded-full bg-slate-100 hover:bg-blue-50 text-slate-700 hover:text-blue-700 border border-slate-200">
              {s}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
