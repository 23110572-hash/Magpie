import React from "react";
import { Coins, Loader2, ShoppingCart } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import type { CreditsInfo } from "@/types";
import { CREDIT_PACKS, MODE_CREDITS, creditsText, rupees } from "@/types";

interface CreditsViewProps {
  balance: number;
  credits: CreditsInfo | null; // null while loading
  buyingPack: string | null;
  onBuy: (packId: string) => void;
}

const REASON_TEXT: Record<string, string> = {
  signup: "Welcome credits", purchase: "Bought credits", run: "Search", refund: "Refund",
};

/** The balance, the packs to top it up, and every change to it. */
export const CreditsView: React.FC<CreditsViewProps> = ({ balance, credits, buyingPack, onBuy }) => (
  <div className="w-full max-w-4xl mx-auto px-4 py-8 space-y-6">
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-3xl font-black text-slate-900 tracking-tight flex items-center gap-2">
          <Coins className="w-7 h-7 text-emerald-600" aria-hidden="true" /> Credits
        </h1>
        <p className="text-base text-slate-600 mt-1">
          Fast {MODE_CREDITS.Fast} · Balanced {MODE_CREDITS.Balanced} · Deep {MODE_CREDITS.Deep} credits per search
        </p>
      </div>
      <div className="text-right">
        <div className="text-3xl font-black text-slate-900">{balance}</div>
        <div className="text-sm text-slate-600">{balance === 1 ? "credit" : "credits"} left</div>
      </div>
    </div>

    <section aria-label="Credit packs" className="card p-6">
      <ul className="grid sm:grid-cols-3 gap-3">
        {(credits?.packs ?? CREDIT_PACKS).map((pack) => (
          <li key={pack.id} className="rounded-xl border border-slate-200 p-4 flex flex-col gap-3">
            <div>
              <div className="text-lg font-bold text-slate-900">{creditsText(pack.credits)}</div>
              <div className="text-sm text-slate-600">{rupees(pack.price_inr)}</div>
            </div>
            <button type="button" onClick={() => onBuy(pack.id)} disabled={!!buyingPack} aria-busy={buyingPack === pack.id}
              aria-label={`Buy ${creditsText(pack.credits)} for ${rupees(pack.price_inr)}`} className="btn-primary">
              {buyingPack === pack.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShoppingCart className="w-4 h-4" />}
              Buy
            </button>
          </li>
        ))}
      </ul>
      <p className="text-sm text-slate-600 mt-4">
        Credits come back only if a search fails. Cancelled searches and searches with no results are not refunded.
      </p>
    </section>

    <section aria-labelledby="credit-history-heading" className="card p-6">
      <h2 id="credit-history-heading" className="text-xl font-bold text-slate-900 mb-1">History</h2>
      {!credits ? (
        <p className="flex items-center gap-2 text-sm text-slate-500 py-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
      ) : credits.history.length === 0 ? (
        <p className="text-sm text-slate-500 py-2">No credit activity yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {credits.history.map((tx) => (
            <li key={tx.id} className="flex items-center justify-between gap-4 py-2.5">
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-800 truncate" title={tx.description || undefined}>
                  {tx.description || REASON_TEXT[tx.reason] || tx.reason}
                </div>
                <div className="text-xs text-slate-500">{formatDateTime(tx.created_at)}</div>
              </div>
              <div className="text-right shrink-0">
                <div className={`text-sm font-bold ${tx.delta > 0 ? "text-emerald-700" : "text-rose-700"}`}>
                  {tx.delta > 0 ? `+${tx.delta}` : tx.delta}
                </div>
                {tx.balance_after != null && <div className="text-xs text-slate-500">Balance {tx.balance_after}</div>}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  </div>
);
