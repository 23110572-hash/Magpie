"""Runs the prompt-to-dataset workflow and streams truthful progress.

  1 planning   - LLM understands the request (any language/spelling) and designs the plan
  2 searching  - chosen sources are queried in parallel, country-aware
  3 reading    - LLM triages web results; list/directory pages are fetched and read by the LLM
  4 checking   - LLM judges every candidate against the request
  5 merging    - duplicates across sources are merged into richer rows
  6 contacts   - published e-mails/phones are looked up on each result's own website
  7 storing    - rows with source URL, timestamp and raw snapshot go to Neon
"""
import asyncio
import logging
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from app.catalog import SOURCES
from app.database import SessionLocal
from app.models import DataRecord, Dataset, WorkflowRun
from app.services import searcher
from app.services.contacts import enrich_contacts
from app.services.extractor import (
    canonical_url, coverage_of, host_of, merge_duplicates, normalize_candidate, prefilter, snapshot,
)
from app.services.judge import MIN_SCORE, judge_candidates
from app.services.llm import USAGE, new_usage
from app.services.planner import plan_collection
from app.services.scraper import PageFetcher, extract_from_page, load_page, never_fetch, triage_results

logger = logging.getLogger("magpie.pipeline")

Broadcast = Callable[[Dict[str, Any]], Awaitable[None]]
TERMINAL_STATUSES = {"completed", "failed", "cancelled"}
ETA_DEFAULTS = {"Fast": 35, "Balanced": 80, "Deep": 160}
PIPELINE_TIMEOUT_SECONDS = 600


class PipelineError(Exception):
    pass


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _persist_run(run_id: str, fields: Dict[str, Any]) -> None:
    with SessionLocal() as db:
        run = db.get(WorkflowRun, run_id)
        if run is None:  # deleted while running
            return
        for key, value in fields.items():
            setattr(run, key, value)
        db.commit()


def _store_dataset(run_id: str, user_id: Optional[str], plan: Dict[str, Any], records: List[Dict[str, Any]],
                   coverage: Dict[str, int]) -> str:
    with SessionLocal() as db:
        if db.get(WorkflowRun, run_id) is None:
            raise PipelineError("The run was deleted before its dataset could be saved")
        dataset = Dataset(user_id=user_id, workflow_run_id=run_id, name=plan["understood_as"][:300],
                          category=plan["intent"], intent=plan["intent"], label=plan["understood_as"],
                          country=plan["market"], place=plan["place"], column_defs=plan["columns"],
                          coverage=coverage, row_count=len(records))
        db.add(dataset)
        db.flush()
        now = _utcnow()
        db.add_all([DataRecord(
            dataset_id=dataset.id, title=r["title"], company=r.get("company"), location=r.get("location"),
            email=r.get("email"), phone=r.get("phone"), website=r.get("website"), score=r.get("score"),
            source=r.get("source"), source_url=r["source_url"], details=r.get("details") or {},
            raw_snapshot=r.get("raw_snapshot") or snapshot(r.get("raw") or {}), created_at=now,
        ) for r in records])
        db.commit()
        return dataset.id


class RunTracker:
    """Live state of one run: persisted off the event loop and broadcast to SSE subscribers."""

    def __init__(self, run_id: str, prompt: str, mode: str, country: str, broadcast: Optional[Broadcast]):
        self.run_id = run_id
        self.broadcast = broadcast
        self.started = time.monotonic()
        self.mode = mode
        self._last_persist = 0.0
        self.state: Dict[str, Any] = {
            "id": run_id, "run_id": run_id, "prompt": prompt, "mode": mode, "country": country,
            "status": "running", "step": "planning", "progress": 1.0, "eta_seconds": ETA_DEFAULTS.get(mode, 80),
            "message": "Starting…", "spec": {}, "stats": {}, "finished_at": None,
        }

    def _eta(self, progress: float) -> int:
        elapsed = time.monotonic() - self.started
        if progress >= 100:
            return 0
        if progress < 15:
            return int(max(5, ETA_DEFAULTS.get(self.mode, 80) - elapsed))
        return int(max(1, min(900, round(elapsed * (100 - progress) / progress))))

    async def update(self, *, step: Optional[str] = None, progress: Optional[float] = None,
                     message: Optional[str] = None, spec: Optional[dict] = None, stats: Optional[dict] = None,
                     status: Optional[str] = None, force_persist: bool = False) -> None:
        changed_step = step is not None and step != self.state["step"]
        if step is not None:
            self.state["step"] = step
        if progress is not None:
            self.state["progress"] = round(max(self.state["progress"], min(100.0, progress)), 1)
        if message is not None:
            self.state["message"] = message[:500]
        if spec is not None:
            self.state["spec"] = spec
        if stats is not None:
            self.state["stats"] = stats
        if status is not None:
            self.state["status"] = status
        terminal = self.state["status"] in TERMINAL_STATUSES
        if terminal:
            self.state["finished_at"] = _utcnow().isoformat().replace("+00:00", "Z")
            self.state["eta_seconds"] = 0
        else:
            self.state["eta_seconds"] = self._eta(self.state["progress"])

        now = time.monotonic()
        if force_persist or terminal or changed_step or spec is not None or now - self._last_persist > 1.5:
            self._last_persist = now
            fields = {k: self.state[k] for k in ("status", "step", "progress", "eta_seconds", "message", "stats")}
            if spec is not None:
                fields["spec"] = spec
            if terminal:
                fields["finished_at"] = _utcnow()
            try:
                await asyncio.to_thread(_persist_run, self.run_id, fields)
            except Exception:
                logger.exception("Could not persist progress for run %s", self.run_id)
                if terminal:
                    raise
        if self.broadcast:
            await self.broadcast(dict(self.state))


async def _gather_with_progress(tasks: List[Tuple[str, str, Awaitable]], on_done) -> None:
    async def wrap(key: str, label: str, coro: Awaitable):
        try:
            return key, label, await coro, None
        except Exception as exc:  # one bad source/page must not fail the run
            logger.warning("%s failed: %s", label, exc)
            return key, label, [], exc

    pending = [asyncio.create_task(wrap(*t)) for t in tasks]
    try:
        for index, fut in enumerate(asyncio.as_completed(pending), 1):
            key, label, rows, err = await fut
            await on_done(index, len(pending), key, label, rows, err)
    finally:
        for task in pending:
            if not task.done():
                task.cancel()


def _diversify(records: List[Dict[str, Any]], cap: int) -> List[Dict[str, Any]]:
    """Cap the list while keeping every source represented (round-robin by source)."""
    buckets: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for rec in records:
        buckets[rec["source"]].append(rec)
    out: List[Dict[str, Any]] = []
    while len(out) < cap and any(buckets.values()):
        for src in list(buckets):
            if buckets[src]:
                out.append(buckets[src].pop(0))
                if len(out) >= cap:
                    break
    return out


async def run_pipeline_orchestrator(run_id: str, user_id: Optional[str], prompt: str, mode: str = "Balanced",
                                    country: str = "IN", forced_intent: Optional[str] = None,
                                    status_callback: Optional[Broadcast] = None) -> None:
    tracker = RunTracker(run_id, prompt, mode, country, status_callback)
    http = searcher.HttpClient(concurrency=10)
    fetcher = PageFetcher(concurrency=6)
    stats: Dict[str, Any] = {"sources": {}}
    usage = new_usage()
    token = USAGE.set(usage)
    try:
        async with asyncio.timeout(PIPELINE_TIMEOUT_SECONDS):
            await _execute(tracker, http, fetcher, stats, run_id, user_id, prompt, mode, country, forced_intent)
    except asyncio.CancelledError:
        stats["llm"], stats["duration_seconds"] = dict(usage), round(time.monotonic() - tracker.started, 1)
        await tracker.update(status="cancelled", step="cancelled", message="Cancelled by you.", stats=stats)
    except TimeoutError:
        stats["error"] = f"Timed out after {PIPELINE_TIMEOUT_SECONDS}s"
        stats["llm"] = dict(usage)
        await tracker.update(status="failed", step="failed", message=stats["error"], stats=stats)
    except Exception as exc:
        logger.exception("Pipeline error for run %s", run_id)
        stats["error"], stats["llm"] = str(exc)[:500], dict(usage)
        await tracker.update(status="failed", step="failed", message=f"Run failed: {exc}", stats=stats)
    finally:
        USAGE.reset(token)
        await http.aclose()
        await fetcher.aclose()


async def _execute(tracker: RunTracker, http: searcher.HttpClient, fetcher: PageFetcher, stats: Dict[str, Any],
                   run_id: str, user_id: Optional[str], prompt: str, mode: str, country: str,
                   forced_intent: Optional[str]) -> None:
    usage = USAGE.get() or new_usage()

    # ---- 1. planning
    await tracker.update(step="planning", progress=3, message="AI is reading your request…", force_persist=True)
    plan = await plan_collection(prompt, mode, country, forced_intent)
    limits = plan["limits"]
    stats["planner"] = plan["planner"]
    if not plan["sources"]:
        missing = ", ".join(s["source"] for s in plan.get("skipped_sources", []))
        raise PipelineError("No usable sources for this request" + (f" (missing: {missing})" if missing else ""))
    await tracker.update(progress=12, spec=plan, stats=stats, message=f"Understood as: {plan['understood_as']}")

    # ---- 2. searching
    tasks = [(key, str(SOURCES[key]["label"]), searcher.SOURCE_FUNCS[key](http, plan))
             for key in plan["sources"] if key in searcher.SOURCE_FUNCS]
    candidates: List[Dict[str, Any]] = []
    web_results: List[Dict[str, Any]] = []

    async def on_search(index, total, key, label, rows, err):
        (web_results if key in searcher.WEB_SOURCES else candidates).extend(rows)
        stats["sources"][label] = {"found": len(rows), **({"error": str(err)[:200]} if err else {})}
        await tracker.update(step="searching", progress=12 + 33 * index / total, stats=stats,
                             message=f"{label}: {len(rows)} results ({index}/{total} sources)")

    await tracker.update(step="searching", progress=13,
                         message="Searching in parallel: " + ", ".join(t[1] for t in tasks))
    await _gather_with_progress(tasks, on_search)
    stats["web_results"], stats["direct_results"] = len(web_results), len(candidates)

    # ---- 3. reading
    unique: List[Dict[str, Any]] = []
    seen = set()
    for result in web_results:
        key = canonical_url(result["url"]) if result.get("url") else None
        if key and key not in seen:
            seen.add(key)
            unique.append(result)
    unique = unique[:60]
    await tracker.update(step="reading", progress=46, stats=stats,
                         message=f"AI is deciding which of {len(unique)} web results to read…")
    decisions = await triage_results(unique, plan)
    to_open: List[Dict[str, Any]] = []
    counts = Counter()
    for idx, result in enumerate(unique):
        action = decisions.get(idx, "entity")
        counts[action] += 1
        if action == "entity":
            candidates.append(searcher.web_result_to_candidate(result))
        elif action == "open" and not never_fetch(result["url"]):
            to_open.append(result)
    to_open = to_open[: limits["pages"]]
    page_stats = Counter()

    async def read(result: Dict[str, Any]) -> List[Dict[str, Any]]:
        page, status = await load_page(fetcher, result["url"])
        page_stats[status] += 1
        if not page:
            return []
        rows = await extract_from_page(page, plan, result)
        page_stats["entries"] += len(rows)
        return rows

    async def on_read(index, total, key, label, rows, err):
        candidates.extend(rows)
        await tracker.update(progress=46 + 19 * index / total,
                             message=f"Read {label}: {len(rows)} entries ({index}/{total} pages)")

    if to_open:
        await tracker.update(message=f"Reading {len(to_open)} list/directory pages (robots.txt respected)…")
        await _gather_with_progress([("page", host_of(r["url"]), read(r)) for r in to_open], on_read)
    stats["triage"] = dict(counts)
    stats["pages"] = {"opened": len(to_open), "read": page_stats["ok"], "entries": page_stats["entries"],
                      "blocked": page_stats["blocked_robots"] + page_stats["not_allowed"],
                      "failed": page_stats["error"] + page_stats["unsafe"]}

    # ---- 4. checking
    normalized = [c for c in (normalize_candidate(x) for x in candidates) if c]
    ranked: List[Dict[str, Any]] = []
    for rec in normalized:
        rec["_pre"], rec["_hits"] = prefilter(rec, plan)
        if not rec["targeted"] and plan["match_terms"] and rec["_hits"] == 0:
            continue  # bulk lists (e.g. a whole company job board) must at least mention the role
        ranked.append(rec)
    ranked.sort(key=lambda r: r["_pre"], reverse=True)
    capped = _diversify(ranked, limits["judge_cap"])
    stats["candidates"], stats["prefiltered_out"] = len(normalized), len(normalized) - len(ranked)
    await tracker.update(step="checking", progress=66, stats=stats,
                         message=f"AI is checking {len(capped)} candidates against your request…")

    async def on_judge(done: int, total: int) -> None:
        await tracker.update(progress=66 + 14 * done / total, message=f"AI checked {done}/{total} batches")

    verdicts = await judge_candidates(capped, plan, on_judge) if capped else []
    kept: List[Dict[str, Any]] = []
    unchecked = 0
    for rec, verdict in zip(capped, verdicts):
        if verdict is None:
            unchecked += 1
            if rec["targeted"] or rec["_hits"]:
                rec["score"] = round(40 + 30 * min(1.0, rec["_pre"]), 1)
                rec["details"]["reason"] = "Matched your keywords (AI check unavailable)"
                kept.append(rec)
            continue
        if not verdict["keep"] or verdict["score"] < MIN_SCORE:
            continue
        rec["score"] = round(verdict["score"], 1)
        rec["details"]["reason"] = verdict["reason"]
        if verdict["name"]:
            rec["title"] = verdict["name"]
        if verdict["organisation"] and not rec.get("company"):
            rec["company"] = verdict["organisation"]
        if not rec.get("location") and (verdict["city"] or verdict["country"]):
            rec["location"] = ", ".join(p for p in (verdict["city"], verdict["country"]) if p)
        for key in ("remote", "salary"):
            if verdict[key] is not None and rec["details"].get(key) in (None, ""):
                rec["details"][key] = verdict[key]
        if verdict["fields"]:
            fields = rec["details"].setdefault("fields", {})
            for fk, fv in verdict["fields"].items():
                fields.setdefault(fk, fv)
        kept.append(rec)
    stats["checked"], stats["kept"], stats["unchecked"] = len(capped), len(kept), unchecked
    stats["rejected"] = len(capped) - len(kept)

    # ---- 5. merging
    await tracker.update(step="merging", progress=81, stats=stats, message="Merging duplicates across sources…")
    merged, removed = merge_duplicates(kept)
    stats["duplicates_merged"] = removed
    merged.sort(key=lambda r: r.get("score") or 0, reverse=True)
    per_source: Dict[str, int] = defaultdict(int)
    final: List[Dict[str, Any]] = []
    for rec in merged:
        if per_source[rec["source"]] >= limits["per_source"]:
            continue
        per_source[rec["source"]] += 1
        final.append(rec)
        if len(final) >= limits["max_records"]:
            break

    # ---- 6. contacts
    await tracker.update(step="contacts", progress=85, stats=stats,
                         message="Looking for published e-mails and phone numbers on their websites…")

    async def on_contact(done: int, total: int) -> None:
        await tracker.update(progress=85 + 10 * done / max(1, total), message=f"Checked {done}/{total} websites for contacts")

    stats["contacts"] = await enrich_contacts(fetcher, final, limits["contact_checks"], on_contact)

    # ---- 7. storing
    for rec in final:
        rec["details"]["columns"] = {c["key"]: (rec["details"].get("fields") or {}).get(c["key"], rec["details"].get(c["key"]))
                                     for c in plan["columns"]}
    coverage = coverage_of(final)
    stats["coverage"] = coverage
    await tracker.update(step="storing", progress=96, stats=stats, message=f"Saving {len(final)} rows to Neon…")
    dataset_id = await asyncio.to_thread(_store_dataset, run_id, user_id, plan, final, coverage)
    stats.update({
        "kept_by_source": dict(Counter(r["source"] for r in final)),
        "total_found": len(normalized),
        "deduplicated_count": len(final),
        "dataset_id": dataset_id,
        "dataset_name": plan["understood_as"],
        "duration_seconds": round(time.monotonic() - tracker.started, 1),
        "llm": dict(usage),
    })
    if len(final) > 1:
        message = f"We have found {len(final)} {plan.get('results_phrase') or 'results'}."
    elif final:
        message = f"We have found 1 match for “{plan['understood_as']}”."
    else:
        message = "We couldn't find anything that matched well enough. Try Deep mode or describe it a little differently."
    await tracker.update(status="completed", step="completed", progress=100, stats=stats, message=message)
