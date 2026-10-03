"""AI planner: turns any request (typos, Hinglish, any city) into an executable collection plan.

There are no built-in vocabularies here: the LLM decides the intent, place, synonyms, columns,
queries and sources. Python only validates the shape of its answer.
"""
import json
import re
from typing import Any, Dict, List, Optional

from app.catalog import (
    ADZUNA_COUNTRIES, ADZUNA_CURRENCY, CORE_SOURCES, EU_COUNTRIES, INTENTS, MARKETS, SOURCES, normalize_sources,
)
from app.config import settings
from app.services.llm import chat_json

# How much each mode searches. Credits: Fast 1, Balanced 2, Deep 4 (see app/credits.py).
MODE_LIMITS: Dict[str, Dict[str, int]] = {
    "Fast": {"web_queries": 2, "serp_results": 10, "serp_pages": 1, "tavily_queries": 1, "tavily_results": 8,
             "places_queries": 1, "places_pages": 1, "places_calls": 2, "cover_cities": 2, "triage_cap": 30,
             "pages": 3, "next_pages": 0, "github_profiles": 15, "github_locations": 2, "adzuna_per_page": 40,
             "adzuna_pages": 1, "adzuna_countries": 1, "ats_companies": 4, "judge_cap": 120, "contact_checks": 12,
             "per_source": 40, "max_records": 80},
    "Balanced": {"web_queries": 4, "serp_results": 10, "serp_pages": 1, "tavily_queries": 2, "tavily_results": 10,
                 "places_queries": 2, "places_pages": 1, "places_calls": 8, "cover_cities": 4, "triage_cap": 60,
                 "pages": 8, "next_pages": 0, "github_profiles": 30, "github_locations": 4, "adzuna_per_page": 50,
                 "adzuna_pages": 1, "adzuna_countries": 2, "ats_companies": 8, "judge_cap": 250,
                 "contact_checks": 30, "per_source": 80, "max_records": 200},
    "Deep": {"web_queries": 8, "serp_results": 10, "serp_pages": 2, "tavily_queries": 4, "tavily_results": 15,
             "places_queries": 4, "places_pages": 2, "places_calls": 24, "cover_cities": 8, "triage_cap": 160,
             "pages": 20, "next_pages": 5, "github_profiles": 90, "github_locations": 6, "adzuna_per_page": 50,
             "adzuna_pages": 2, "adzuna_countries": 4, "ats_companies": 12, "judge_cap": 600, "contact_checks": 80,
             "per_source": 200, "max_records": 500},
}

# Fixed columns every dataset shows; the planner adds request-specific ones on top.
RESERVED_COLUMNS = {"name", "title", "source", "url", "source_url", "email", "phone", "website", "location",
                    "organisation", "organization", "company", "city", "country", "score"}
DEFAULT_COLUMNS: Dict[str, List[Dict[str, str]]] = {
    "people": [{"key": "role", "label": "Role"}, {"key": "skills", "label": "Skills"},
               {"key": "experience", "label": "Experience"}, {"key": "summary", "label": "Summary"}],
    "jobs": [{"key": "salary", "label": "Salary"}, {"key": "experience", "label": "Experience"},
             {"key": "job_type", "label": "Job type"}, {"key": "posted", "label": "Posted"}],
    "companies": [{"key": "industry", "label": "Industry"}, {"key": "size", "label": "Size"},
                  {"key": "summary", "label": "Summary"}],
    "local_businesses": [{"key": "category", "label": "Category"}, {"key": "rating", "label": "Rating"},
                         {"key": "summary", "label": "Summary"}],
    "events": [{"key": "date", "label": "Date"}, {"key": "event_type", "label": "Type"},
               {"key": "summary", "label": "Summary"}],
    "news": [{"key": "publisher", "label": "Publisher"}, {"key": "date", "label": "Date"},
             {"key": "summary", "label": "Summary"}],
    "market": [{"key": "metric", "label": "Metric"}, {"key": "value", "label": "Value"},
               {"key": "date", "label": "Date"}, {"key": "summary", "label": "Summary"}],
    "other": [{"key": "summary", "label": "Summary"}],
}

PLANNER_PROMPT = """You are the planning brain of Magpie, a data-collection platform.
Users write in any language or mix (e.g. Hinglish), with typos, slang and broken grammar. Work out what they
really want and design a plan to collect it from the web. The user selected the market: {market}.
Places named in the request are normally inside that market.

Return ONLY a JSON object with these keys:
- "corrected_prompt": the request rewritten as clear English (fix spelling, translate).
- "understood_as": one short phrase for the dataset, e.g. "Web developers (people) in Chandigarh, India".
- "results_phrase": plural phrase that completes the sentence "We have found 25 ...", e.g. "backend developers in
    Odisha", "React JS jobs for freshers in Bangalore", "sponsors for college tech fests in Delhi".
- "intent": one of people | jobs | companies | local_businesses | events | news | market | other.
    people = individual professionals / freelancers to contact or hire ("I need a designer" -> people).
    jobs = job openings / vacancies ("designer jobs", "hiring", "openings", "internships").
    companies = organisations / startups / brands. local_businesses = studios, agencies, shops, clinics or
    service providers with a physical presence. events = conferences, fests, meetups, sponsorships.
    news = recent articles. market = figures, prices, trends, reports. other = anything else.
- "alternatives": up to 3 other plausible readings: [{{"intent": "...", "label": "short label"}}].
- "entity": singular noun for ONE result row, e.g. "graphic designer", "web design agency", "job posting".
- "match_terms": 1-3 groups of synonyms; a relevant row mentions at least one term of each group.
    e.g. [["graphic designer","visual designer","brand designer","logo designer","illustrator"]]
- "place": {{"city": string|null, "region": string|null, "country": string, "country_code": ISO 3166-1 alpha-2
    lowercase, "aliases": other spellings of the city/region (e.g. ["bengaluru","bangalore"]),
    "scope": "city"|"region"|"country"|"remote"|"any"}}
- "cover_cities": when scope is country or region (e.g. "all over India"), exactly {cover_cities} major cities to
    cover; else [].
- "filters": {{"remote": true|false|null, "seniority": [..], "experience": string|null,
    "min_salary": {{"amount": number, "currency": "INR"|"USD"|"EUR"|..., "period": "year"|"month"|"hour"}}|null,
    "recency_days": number|null, "needs_contact": true|false}}
- "columns": 3-7 extra fields to show per row as [{{"key": "snake_case", "label": "Label"}}]. Do not include
    name, organisation, location, email, phone, website, source or url - they are always shown.
- "queries": {{
    "web": exactly {web_queries} different Google queries that surface listing pages, directories and profiles
           for this exact request, each including the place. Make every query different: synonyms of the role,
           nearby areas, directories, marketplaces and "top N" lists. For people include profile searches such as
           site:linkedin.com/in "<role>" "<city>" and portfolio/freelancer sites that suit the profession.
    "places": 0-{places_queries} Google Maps queries (for local_businesses, or professionals who run a
           studio/agency/practice),
    "jobs": short job-search keywords or null,
    "github_languages": up to 3 GitHub languages when software developers are wanted, else [],
    "news": 0-2 news queries }}
- "sources": the best subset of AVAILABLE_SOURCES for this request.
- "target_companies": only for jobs, up to 12 real companies in this market likely hiring for it, else [].

AVAILABLE_SOURCES:
{sources}
Return valid JSON only."""


def _s(value: Any, limit: int = 200) -> str:
    if value is None or isinstance(value, (dict, list)):
        return ""
    return " ".join(str(value).split())[:limit]


def _str_list(value: Any, limit: int, item_len: int = 120) -> List[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: List[str] = []
    for item in value:
        if isinstance(item, dict):
            item = item.get("name") or item.get("value") or item.get("query") or ""
        text = _s(item, item_len)
        if text and text not in out:
            out.append(text)
    return out[:limit]


def _match_groups(value: Any) -> List[List[str]]:
    if not isinstance(value, list):
        return []
    if value and all(isinstance(v, str) for v in value):
        value = [value]  # a flat list is one synonym group
    groups: List[List[str]] = []
    for group in value:
        terms = [t.lower() for t in _str_list(group, 15, 60)]
        if terms:
            groups.append(terms)
    return groups[:3]


def _columns(value: Any, intent: str) -> List[Dict[str, str]]:
    cols: List[Dict[str, str]] = []
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                item = {"key": item, "label": item}
            if not isinstance(item, dict):
                continue
            key = re.sub(r"[^a-z0-9]+", "_", _s(item.get("key") or item.get("label"), 40).lower()).strip("_")
            label = _s(item.get("label") or key.replace("_", " ").title(), 40)
            # "job_title", "company_name", "contact_email"... duplicate the fixed columns.
            if key and not set(key.split("_")) & RESERVED_COLUMNS and all(c["key"] != key for c in cols):
                cols.append({"key": key, "label": label})
    return cols[:7] or DEFAULT_COLUMNS.get(intent, DEFAULT_COLUMNS["other"])


def _filters(value: Any) -> Dict[str, Any]:
    f = value if isinstance(value, dict) else {}
    salary = f.get("min_salary")
    min_salary = None
    if isinstance(salary, dict) and isinstance(salary.get("amount"), (int, float)) and salary["amount"] > 0:
        period = _s(salary.get("period"), 10).lower()
        min_salary = {"amount": float(salary["amount"]), "currency": _s(salary.get("currency"), 5).upper() or None,
                      "period": period if period in ("year", "month", "hour") else "year"}
    recency = f.get("recency_days")
    return {
        "remote": f["remote"] if isinstance(f.get("remote"), bool) else None,
        "seniority": _str_list(f.get("seniority"), 5, 30),
        "experience": _s(f.get("experience"), 60) or None,
        "min_salary": min_salary,
        "recency_days": int(recency) if isinstance(recency, (int, float)) and 0 < recency <= 3650 else None,
        "needs_contact": bool(f.get("needs_contact")),
    }


def _place(value: Any, market: Dict[str, Any]) -> Dict[str, Any]:
    p = value if isinstance(value, dict) else {}
    city, region = _s(p.get("city"), 80) or None, _s(p.get("region"), 80) or None
    scope = _s(p.get("scope"), 12).lower()
    if scope not in ("city", "region", "country", "remote", "any"):
        scope = "city" if city else ("region" if region else "country")
    code = re.sub(r"[^a-z]", "", _s(p.get("country_code"), 4).lower())[:2] or market["code"]
    return {"city": city, "region": region, "country": _s(p.get("country"), 60) or market["country"],
            "country_code": code or None, "aliases": [a.lower() for a in _str_list(p.get("aliases"), 10, 60)],
            "scope": scope}


def _search_settings(place: Dict[str, Any], market_code: str) -> Dict[str, Any]:
    """Country parameters for each search API, derived from the planned place."""
    market = MARKETS[market_code]
    code = place.get("country_code")
    if market_code == "EU" or (code and code != market["code"]):
        gl = code if code else None
        tavily = EU_COUNTRIES.get(code or "") or {"in": "india", "us": "united states", "gb": "united kingdom"}.get(code or "")
        if code in ADZUNA_COUNTRIES:
            adzuna = [code]
        else:
            adzuna = list(market["adzuna"]) if market_code == "EU" and not code else []
    else:
        gl, tavily, adzuna = market["gl"], market["tavily"], list(market["adzuna"])
    return {"gl": gl, "tavily_country": tavily, "adzuna_countries": adzuna,
            "currency": {c: ADZUNA_CURRENCY.get(c, "EUR") for c in adzuna}}


def _choose_sources(plan: Dict[str, Any], suggested: List[str], market_code: str) -> None:
    intent = plan["intent"]
    chosen = list(dict.fromkeys(CORE_SOURCES.get(intent, CORE_SOURCES["other"]) + suggested))
    queries = plan["queries"]
    if queries["places"] and "serper_places" not in chosen:
        chosen.append("serper_places")
    if queries["github_languages"] and intent == "people" and "github_users" not in chosen:
        chosen.append("github_users")
    if intent == "news" and "serper_news" not in chosen:
        chosen.append("serper_news")
    if intent == "jobs" and plan["filters"].get("remote") and "remotive" not in chosen:
        chosen.append("remotive")
    if intent == "jobs" and plan["target_companies"] and "ats_boards" not in chosen:
        chosen.append("ats_boards")
    # Coverage facts about the sources themselves (not about the request):
    if market_code != "EU":
        chosen = [s for s in chosen if s != "arbeitnow"]
    if "serper_places" in chosen and not queries["places"]:
        queries["places"] = [f"{plan['entity']} in {plan['place'].get('city') or plan['place'].get('region') or plan['place']['country']}"]
    keys = {"serper": bool(settings.SERPER_API_KEY), "tavily": bool(settings.TAVILY_API_KEY),
            "adzuna": bool(settings.ADZUNA_APP_ID and settings.ADZUNA_APP_KEY)}
    active, skipped = [], []
    for src in chosen:
        need = SOURCES[src].get("requires")
        if need and not keys.get(str(need)):
            skipped.append({"source": src, "reason": "API key not configured"})
        elif src == "adzuna" and not plan["search"]["adzuna_countries"]:
            skipped.append({"source": src, "reason": "not available for this country"})
        else:
            active.append(src)
    plan["sources"], plan["skipped_sources"] = active, skipped


def _phrase_from(understood: str) -> str:
    """'Web developers in Chandigarh' -> 'web developers in Chandigarh' (keeps acronyms like 'AI startups')."""
    return understood[0].lower() + understood[1:] if re.match(r"^[A-Z][a-z]+\b", understood) else understood


def _fallback(prompt: str, market: Dict[str, Any], intent: str) -> Dict[str, Any]:
    """Used only when the LLM is unreachable: search the web for the user's own words."""
    return {
        "corrected_prompt": prompt, "understood_as": prompt, "results_phrase": f"results for “{prompt}”",
        "intent": intent, "alternatives": [],
        "entity": "result", "match_terms": [],
        "place": {"city": None, "region": None, "country": market["country"], "country_code": market["code"],
                  "aliases": [], "scope": "country"},
        "cover_cities": [], "filters": _filters({}), "columns": DEFAULT_COLUMNS.get(intent, DEFAULT_COLUMNS["other"]),
        "queries": {"web": [prompt], "places": [], "jobs": prompt if intent == "jobs" else None,
                    "github_languages": [], "news": [prompt] if intent == "news" else []},
        "target_companies": [], "_suggested": [],
    }


def _normalize(raw: Dict[str, Any], prompt: str, market: Dict[str, Any], forced: Optional[str]) -> Dict[str, Any]:
    intent = forced or _s(raw.get("intent"), 30).lower()
    if intent not in INTENTS:
        intent = "other"
    corrected = _s(raw.get("corrected_prompt"), 500) or prompt
    alternatives = []
    for alt in raw.get("alternatives") or []:
        if isinstance(alt, dict) and _s(alt.get("intent"), 30).lower() in INTENTS:
            alt_intent = _s(alt.get("intent"), 30).lower()
            if alt_intent != intent and all(a["intent"] != alt_intent for a in alternatives):
                alternatives.append({"intent": alt_intent, "label": _s(alt.get("label"), 80) or alt_intent})
    queries = raw.get("queries") if isinstance(raw.get("queries"), dict) else {}
    place = _place(raw.get("place"), market)
    understood = _s(raw.get("understood_as"), 200) or corrected
    return {
        "corrected_prompt": corrected,
        "understood_as": understood,
        "results_phrase": _s(raw.get("results_phrase"), 160).rstrip(".") or _phrase_from(understood),
        "intent": intent,
        "alternatives": alternatives[:3],
        "entity": _s(raw.get("entity"), 80) or "result",
        "match_terms": _match_groups(raw.get("match_terms")),
        "place": place,
        "cover_cities": _str_list(raw.get("cover_cities"), 8, 60) if place["scope"] in ("country", "region") else [],
        "filters": _filters(raw.get("filters")),
        "columns": _columns(raw.get("columns"), intent),
        "queries": {
            "web": _str_list(queries.get("web"), 10, 220) or [corrected],
            "places": _str_list(queries.get("places"), 4, 160),
            "jobs": _s(queries.get("jobs"), 120) or None,
            "github_languages": _str_list(queries.get("github_languages"), 3, 30),
            "news": _str_list(queries.get("news"), 3, 220),
        },
        "target_companies": _str_list(raw.get("target_companies"), 12, 80) if intent == "jobs" else [],
        "_suggested": normalize_sources(raw.get("sources")),
    }


def _top_up_queries(plan: Dict[str, Any], target: int) -> None:
    """Make sure the plan has as many Google queries as the mode pays for (Deep = 8), even if the AI wrote fewer."""
    web = plan["queries"]["web"]
    place = plan["place"]
    where = place.get("city") or place.get("region") or place.get("country") or ""
    entity = plan["entity"] if plan["entity"] != "result" else ""
    extra = [plan["corrected_prompt"]]
    if entity:
        extra += [f"{entity} {where}", f"best {entity} in {where}", f"{entity} {where} contact details",
                  f"{entity} directory {where}", f"list of {entity} in {where}", f"top {entity} {where}"]
    seen = {q.lower() for q in web}
    for query in extra:
        if len(web) >= target:
            break
        query = " ".join(query.split())
        if query and query.lower() not in seen:
            web.append(query)
            seen.add(query.lower())


async def plan_collection(prompt: str, mode: str, market_code: str, forced_intent: Optional[str] = None) -> Dict[str, Any]:
    mode = mode if mode in MODE_LIMITS else "Balanced"
    limits = MODE_LIMITS[mode]
    market_code = market_code if market_code in MARKETS else "IN"
    market = MARKETS[market_code]
    catalog = "\n".join(f"- {key}: {meta['description']}" for key, meta in SOURCES.items())
    user = f"SELECTED MARKET: {market['label']}\nREQUEST: {prompt}"
    if forced_intent:
        user += f"\nThe user explicitly wants intent = {forced_intent}. Plan for that intent."

    system = PLANNER_PROMPT.format(market=market["label"], sources=catalog, web_queries=limits["web_queries"],
                                   places_queries=limits["places_queries"], cover_cities=limits["cover_cities"])
    raw = await chat_json(system, user, max_tokens=2200, timeout=45) if settings.llm_enabled else None
    if isinstance(raw, dict):
        plan = _normalize(raw, prompt, market, forced_intent)
        plan["planner"], plan["planner_note"] = "llm", None
    else:
        plan = _fallback(prompt, market, forced_intent or "other")
        plan["planner"] = "fallback"
        plan["planner_note"] = ("AI planner unavailable (no OPENROUTER_API_KEY)" if not settings.llm_enabled
                                else "AI planner did not answer, so Magpie searched the web for your exact words")

    plan["mode"], plan["market"], plan["market_label"] = mode, market_code, market["label"]
    plan["limits"] = limits
    _top_up_queries(plan, limits["web_queries"])
    plan["search"] = _search_settings(plan["place"], market_code)
    suggested = plan.pop("_suggested", [])
    _choose_sources(plan, suggested, market_code)
    plan["summary"] = plan["understood_as"]
    return plan


def plan_brief(plan: Dict[str, Any]) -> str:
    """Compact description of the plan for downstream LLM steps."""
    place = plan["place"]
    where = ", ".join(p for p in [place.get("city"), place.get("region"), place.get("country")] if p)
    return json.dumps({
        "request": plan["corrected_prompt"], "wanted": plan["understood_as"], "intent": plan["intent"],
        "one_row_is": plan["entity"], "place": where, "place_scope": place.get("scope"),
        "filters": {k: v for k, v in plan["filters"].items() if v not in (None, [], False)},
    }, ensure_ascii=False)
