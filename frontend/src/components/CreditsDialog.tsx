import React, { useEffect, useRef } from "react";
import { Coins, Loader2, ShoppingCart, X } from "lucide-react";
import type { CreditPack, Mode } from "@/types";
import { creditsText, rupees } from "@/types";

interface CreditsDialogProps {
  mode: Mode;
  /** What the waiting search costs. */
  needed: number;
  balance: number;
  packs: CreditPack[];
  buyingPack: string | null;
  onBuy: (packId: string) => void;
  onCancel: () => void;
}

/** Opens when a search costs more than the balance. Once a purchase covers it, the search starts by itself. */
export const CreditsDialog: React.FC<CreditsDialogProps> = ({ mode, needed, balance, packs, buyingPack, onBuy, onCancel }) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Move focus into the dialog, and back to where it was (usually the prompt box) when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    return () => previous?.focus();
  }, []);

  return (
    <div onClick={onCancel} className="fixed inset-0 z-[70] bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-4 print:hidden">
      <div ref={panelRef} tabIndex={-1} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true"
        aria-labelledby="credits-title" aria-describedby="credits-desc credits-need"
        className="card relative w-full max-w-lg p-7 sm:p-8 shadow-2xl max-h-[95vh] overflow-y-auto focus:outline-none">
        <button type="button" onClick={onCancel} aria-label="Close"
          className="absolute right-3 top-3 p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100">
          <X className="w-5 h-5" />
        </button>
        <div className="w-12 h-12 rounded-2xl bg-emerald-50 border border-emerald-200 flex items-center justify-center text-emerald-600 mb-4">
          <Coins className="w-6 h-6" aria-hidden="true" />
        </div>
        <h2 id="credits-title" className="text-2xl font-black text-slate-900">You need more credits</h2>
        <p id="credits-desc" className="text-sm text-slate-600 mt-1 mb-5">
          Your {mode} search is waiting. Pick a pack and it starts as soon as your balance covers it.
        </p>

        <dl id="credits-need" className="grid grid-cols-2 gap-3 mb-5">
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <dt className="text-sm text-slate-600">This search needs</dt>
            <dd className="text-xl font-black text-slate-900">{creditsText(needed)}</dd>
          </div>
          <div className={`rounded-xl border px-4 py-3 ${balance >= needed ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
            <dt className="text-sm text-slate-600">Your balance</dt>
            <dd className="text-xl font-black text-slate-900">{creditsText(balance)}</dd>
          </div>
        </dl>

        <ul className="space-y-2">
          {packs.map((pack) => (
            <li key={pack.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
              <div>
                <div className="text-base font-bold text-slate-900">{creditsText(pack.credits)}</div>
                <div className="text-sm text-slate-600">{rupees(pack.price_inr)}</div>
              </div>
              <button type="button" onClick={() => onBuy(pack.id)} disabled={!!buyingPack} aria-busy={buyingPack === pack.id}
                aria-label={`Buy ${creditsText(pack.credits)} for ${rupees(pack.price_inr)}`} className="btn-primary shrink-0">
                {buyingPack === pack.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
                Buy
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-6 flex justify-end">
          <button type="button" onClick={onCancel} className="btn-secondary">Cancel</button>
        </div>
      </div>
    </div>
  );
};
