"""AI relevance check: the LLM decides, in parallel batches, which candidates really match the request."""
import asyncio
import json
from typing import Any, Awaitable, Callable, Dict, List, Optional

from app.services.extractor import clean_text, host_of
from app.services.llm import chat_json
from app.services.planner import plan_brief

BATCH_SIZE = 20
MIN_SCORE = 55

JUDGE_PROMPT = """You are the quality checker of a data-collection platform.
REQUEST (JSON): {brief}
One row must be ONE {entity}. Decide which candidates genuinely satisfy the request. Be strict about the kind of
thing and the place, tolerant of spelling variants, synonyms and missing details.
Rules:
- Reject list articles ("Top 10 ..."), directories, search pages, generic blog posts, ads, and results clearly in
  another city/country than requested - unless the request itself wants articles/news/reports.
- For jobs, reject non-job pages and roles that do not match. For people, reject companies and job ads.
- Reject a row whose title is a page heading rather than one entity's name (e.g. "Sponsors | Fest 2026",
  "We are proud to announce our sponsors") and rows that are a different kind of thing than a {entity}
  (e.g. the college hosting an event when sponsors are wanted).
- If the candidate clearly contradicts a filter in the request (e.g. "4+ years" when freshers are wanted,
  on-site when remote is wanted, salary below the minimum), reject it.
- If the location is unknown but everything else fits, keep it with a lower score.
- score = 0-100 confidence that this row is what the user wants.
- Use ONLY the candidate's information. Never invent e-mails, phone numbers, URLs or facts.
Return JSON: {{"results": [{{"id": number, "keep": boolean, "score": number, "reason": "max 12 words",
  "name": "clean display name (person/business name, job title for jobs, headline for articles)",
  "organisation": string|null, "city": string|null, "country": string|null, "remote": boolean|null,
  "salary": string|null, "fields": {{{columns}}}}}]}}
Include every candidate id exactly once."""


def _candidate_view(idx: int, rec: Dict[str, Any]) -> Dict[str, Any]:
    d = rec["details"]
    extra = {k: d[k] for k in ("category", "rating", "reviews", "followers", "public_repos", "hireable", "salary",
                               "job_type", "remote", "posted", "date", "publisher", "matched_via", "role")
             if d.get(k) not in (None, "", [])}
    if isinstance(d.get("fields"), dict):
        extra.update({k: v for k, v in list(d["fields"].items())[:6]})
    return {"id": idx, "title": rec["title"], "organisation": rec.get("company"), "location": rec.get("location"),
            "source": rec["source"], "site": host_of(rec["source_url"]),
            "text": clean_text(d.get("description") or d.get("snippet") or d.get("bio") or "", 380), "extra": extra}


async def judge_candidates(records: List[Dict[str, Any]], plan: Dict[str, Any],
                           on_batch: Optional[Callable[[int, int], Awaitable[None]]] = None) -> List[Optional[Dict[str, Any]]]:
    """Returns one verdict per record (None when the AI check for that batch was unavailable)."""
    columns = ", ".join(f'"{c["key"]}": value or null' for c in plan["columns"])
    system = JUDGE_PROMPT.format(brief=plan_brief(plan), entity=plan["entity"], columns=columns)
    batches = [list(range(i, min(i + BATCH_SIZE, len(records)))) for i in range(0, len(records), BATCH_SIZE)]
    verdicts: List[Optional[Dict[str, Any]]] = [None] * len(records)
    done = 0

    async def run(batch: List[int]) -> None:
        nonlocal done
        view = [_candidate_view(i, records[i]) for i in batch]
        data = await chat_json(system, "CANDIDATES:\n" + json.dumps(view, ensure_ascii=False, default=str),
                               max_tokens=4000, timeout=60)
        for row in (data or {}).get("results", []) if isinstance(data, dict) else []:
            if not isinstance(row, dict) or row.get("id") not in batch:
                continue
            try:
                score = float(row.get("score") or 0)
            except (TypeError, ValueError):
                score = 0.0
            verdicts[row["id"]] = {
                "keep": bool(row.get("keep")), "score": max(0.0, min(100.0, score)),
                "reason": clean_text(row.get("reason"), 140),
                "name": clean_text(row.get("name"), 200) or None,
                "organisation": clean_text(row.get("organisation"), 200) or None,
                "city": clean_text(row.get("city"), 80) or None,
                "country": clean_text(row.get("country"), 60) or None,
                "remote": row["remote"] if isinstance(row.get("remote"), bool) else None,
                "salary": clean_text(row.get("salary"), 80) or None,
                "fields": {str(k)[:40]: v for k, v in (row.get("fields") or {}).items()
                           if isinstance(v, (str, int, float)) and str(v).strip() and str(v).lower() != "null"}
                if isinstance(row.get("fields"), dict) else {},
            }
        done += 1
        if on_batch:
            await on_batch(done, len(batches))

    await asyncio.gather(*(run(b) for b in batches))
    return verdicts
