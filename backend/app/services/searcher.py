"""Source adapters. Every adapter reads the AI plan (queries, place, country settings) and returns either
web search results (for the AI triage step) or candidate records. Nothing is invented: every field comes
from the source payload, which is kept in `raw` for the provenance snapshot."""
import asyncio
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, quote_plus

import httpx

from app.config import settings
from app.services.extractor import clean_text, extract_emails, html_to_text, website_url

logger = logging.getLogger("magpie.search")

_CACHE: Dict[str, Tuple[float, Any]] = {}


def _cache_get(key: str) -> Any:
    hit = _CACHE.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    _CACHE.pop(key, None)
    return None


def _cache_set(key: str, value: Any, ttl: int) -> None:
    if len(_CACHE) > 600:
        for k in sorted(_CACHE, key=lambda k: _CACHE[k][0])[:150]:
            _CACHE.pop(k, None)
    _CACHE[key] = (time.time() + ttl, value)


class HttpClient:
    """Shared async client: polite UA, redirects, bounded concurrency, optional response caching."""

    def __init__(self, concurrency: int = 10):
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(25.0, connect=10.0),
            follow_redirects=True,
            headers={"User-Agent": settings.HTTP_USER_AGENT, "Accept": "application/json"},
            limits=httpx.Limits(max_connections=30, max_keepalive_connections=15),
        )
        self.sem = asyncio.Semaphore(concurrency)

    async def json(self, method: str, url: str, *, params: Optional[dict] = None, json_body: Any = None,
                   headers: Optional[dict] = None, cache_ttl: int = 0) -> Optional[Any]:
        key = f"{method}|{url}|{sorted((params or {}).items())}|{json_body}" if cache_ttl else ""
        if key:
            cached = _cache_get(key)
            if cached is not None:
                return cached
        async with self.sem:
            try:
                res = await self.client.request(method, url, params=params, json=json_body, headers=headers)
            except httpx.HTTPError as exc:
                logger.info("%s %s failed: %s", method, url.split("?")[0], exc.__class__.__name__)
                return None
        if res.status_code != 200:
            logger.info("%s %s -> HTTP %s %s", method, url.split("?")[0], res.status_code, res.text[:160])
            return None
        try:
            data = res.json()
        except ValueError:
            return None
        if key:
            _cache_set(key, data, cache_ttl)
        return data

    async def aclose(self) -> None:
        await self.client.aclose()


def _iso_from_epoch(value: Any) -> Optional[str]:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    if num > 1e12:
        num /= 1000
    return datetime.fromtimestamp(num, tz=timezone.utc).isoformat()


def _trim(obj: Dict[str, Any], drop: Tuple[str, ...] = (), limit: int = 3000) -> Dict[str, Any]:
    out = {}
    for key, value in (obj or {}).items():
        if key in drop:
            continue
        if isinstance(value, str) and len(value) > limit:
            value = value[:limit] + "…"
        out[key] = value
    return out


def _plain_query(query: str) -> str:
    """Strip search operators (site:, quotes, OR) for APIs that take plain keywords."""
    query = re.sub(r"\S+:\S+", " ", query or "")
    query = query.replace('"', " ").replace(" OR ", " ")
    return " ".join(query.split())


def _job_terms(plan: Dict[str, Any]) -> str:
    return plan["queries"].get("jobs") or plan.get("entity") or _plain_query(plan["queries"]["web"][0])


def _serper_headers() -> Dict[str, str]:
    return {"X-API-KEY": settings.SERPER_API_KEY, "Content-Type": "application/json"}


# ---------------------------------------------------------------- web search (results go to AI triage)
async def serper_web(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not settings.SERPER_API_KEY:
        return []
    limits, gl = plan["limits"], plan["search"]["gl"]

    async def one(query: str, page: int) -> List[Dict[str, Any]]:
        body: Dict[str, Any] = {"q": query, "num": limits["serp_results"], "hl": "en"}
        if gl:
            body["gl"] = gl
        if page > 1:  # Deep also reads Google's second results page
            body["page"] = page
        data = await http.json("POST", "https://google.serper.dev/search", json_body=body,
                               headers=_serper_headers(), cache_ttl=1800)
        offset = (page - 1) * limits["serp_results"]
        rows = []
        for pos, item in enumerate((data or {}).get("organic", []), 1):
            if item.get("link"):
                rows.append({"title": item.get("title"), "url": item.get("link"), "snippet": item.get("snippet"),
                             "date": item.get("date"), "engine": "Google search", "query": query,
                             "position": offset + pos, "raw": item})
        return rows

    queries = plan["queries"]["web"][: limits["web_queries"]]
    pages = range(1, limits["serp_pages"] + 1)
    batches = await asyncio.gather(*(one(q, p) for q in queries for p in pages))
    return [row for rows in batches for row in rows]


async def tavily_search(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not settings.TAVILY_API_KEY:
        return []
    limits = plan["limits"]
    headers = {"Authorization": f"Bearer {settings.TAVILY_API_KEY}", "Content-Type": "application/json"}
    topic = "news" if plan["intent"] == "news" else "general"
    recency = plan["filters"].get("recency_days")
    queries = ([q for q in plan["queries"]["web"] if "site:" not in q][: limits["tavily_queries"]]
               or [plan["corrected_prompt"]])

    async def one(query: str) -> List[Dict[str, Any]]:
        body: Dict[str, Any] = {"query": query[:380], "max_results": limits["tavily_results"], "topic": topic,
                                "search_depth": "basic"}
        if topic == "general" and plan["search"]["tavily_country"]:
            body["country"] = plan["search"]["tavily_country"]
        if recency:
            body["time_range"] = "week" if recency <= 7 else "month" if recency <= 31 else "year"
        data = await http.json("POST", "https://api.tavily.com/search", json_body=body, headers=headers, cache_ttl=1800)
        if data is None and "country" in body:  # retry without the country boost
            body.pop("country")
            data = await http.json("POST", "https://api.tavily.com/search", json_body=body, headers=headers, cache_ttl=1800)
        rows = []
        for pos, item in enumerate((data or {}).get("results", []), 1):
            if item.get("url"):
                rows.append({"title": item.get("title"), "url": item.get("url"), "snippet": item.get("content"),
                             "date": item.get("published_date"), "engine": "Tavily", "query": query,
                             "position": pos, "raw": item})
        return rows

    batches = await asyncio.gather(*(one(q) for q in queries))
    return [row for rows in batches for row in rows]


def web_result_to_candidate(result: Dict[str, Any]) -> Dict[str, Any]:
    snippet = clean_text(result.get("snippet"), 700)
    return {
        "title": result.get("title"),
        "company": None,
        "location": None,
        "source": result.get("engine") or "Web search",
        "source_url": result.get("url"),
        "details": {"description": snippet, "snippet": snippet, "posted_at": result.get("date"),
                    "search_query": result.get("query"), "emails": extract_emails(result.get("snippet") or "")},
        "raw": result.get("raw") or result,
        "targeted": True,
    }


# ---------------------------------------------------------------- Google Maps & News (direct records)
async def serper_places(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not settings.SERPER_API_KEY:
        return []
    limits, gl = plan["limits"], plan["search"]["gl"]
    queries = plan["queries"]["places"][: limits["places_queries"]]
    cities = plan["cover_cities"][: limits["cover_cities"]] if plan["place"]["scope"] in ("country", "region") else []
    searches: List[str] = []
    for query in queries:
        if cities:
            searches += [query if city.lower() in query.lower() else f"{query} in {city}" for city in cities]
        else:
            searches.append(query)
    # Country-wide Deep searches would multiply to 4 queries x 8 cities x 2 pages; cap the Maps calls per run.
    searches = list(dict.fromkeys(searches))[: max(1, limits["places_calls"] // limits["places_pages"])]

    async def one(query: str, page: int) -> List[Dict[str, Any]]:
        body: Dict[str, Any] = {"q": query, "hl": "en"}
        if gl:
            body["gl"] = gl
        if page > 1:
            body["page"] = page
        data = await http.json("POST", "https://google.serper.dev/places", json_body=body,
                               headers=_serper_headers(), cache_ttl=3600)
        rows = []
        for item in (data or {}).get("places") or (data or {}).get("maps") or []:
            title = item.get("title")
            if not title:
                continue
            cid = item.get("cid")
            maps_url = (f"https://maps.google.com/?cid={cid}" if cid else
                        f"https://www.google.com/maps/search/?api=1&query={quote_plus(title + ' ' + (item.get('address') or ''))}")
            rows.append({
                "title": title,
                "company": title,
                "location": item.get("address"),
                "phone": item.get("phoneNumber"),
                "website": item.get("website"),
                "source": "Google Maps",
                "source_url": maps_url,
                "details": {"category": item.get("category"), "rating": item.get("rating"),
                            "reviews": item.get("ratingCount"), "address": item.get("address"),
                            "maps_url": maps_url, "search_query": query},
                "raw": item,
                "targeted": True,
            })
        return rows

    calls = [one(q, page) for q in searches for page in range(1, limits["places_pages"] + 1)]
    batches = await asyncio.gather(*calls)
    return [row for rows in batches for row in rows]


async def serper_news(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not settings.SERPER_API_KEY:
        return []
    gl = plan["search"]["gl"]
    queries = plan["queries"]["news"] or plan["queries"]["web"][:1]
    out: List[Dict[str, Any]] = []
    for query in queries[:2]:
        body: Dict[str, Any] = {"q": _plain_query(query) or query, "num": plan["limits"]["serp_results"], "hl": "en"}
        if gl:
            body["gl"] = gl
        data = await http.json("POST", "https://google.serper.dev/news", json_body=body,
                               headers=_serper_headers(), cache_ttl=1800)
        for item in (data or {}).get("news", []):
            if item.get("link"):
                out.append({"title": item.get("title"), "company": item.get("source"), "location": None,
                            "source": "Google News", "source_url": item.get("link"),
                            "details": {"description": item.get("snippet"), "publisher": item.get("source"),
                                        "date": item.get("date"), "search_query": query},
                            "raw": item, "targeted": True})
    return out


# ---------------------------------------------------------------- GitHub developer profiles
async def github_users(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    limits, place = plan["limits"], plan["place"]
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    if settings.GITHUB_TOKEN:
        headers["Authorization"] = f"Bearer {settings.GITHUB_TOKEN}"
    spread = limits["github_locations"]
    if place.get("city"):
        aliases = [a for a in (place.get("aliases") or []) if a.lower() != place["city"].lower()]
        locations = [place["city"]] + aliases[: max(1, spread - 1)]
    elif place.get("region"):
        locations = [place["region"]] + list(plan["cover_cities"][: max(0, spread - 1)])
    else:
        locations = list(plan["cover_cities"][: max(1, spread - 1)]) + [place.get("country") or ""]
    locations = [loc for loc in dict.fromkeys(locations) if loc and loc.lower() not in ("europe", "remote")][:spread]
    languages = plan["queries"]["github_languages"][:2] or [""]
    if not locations:
        return []
    per_page = min(100, max(30, limits["github_profiles"]))  # one GitHub search returns at most 100 people

    async def search(location: str, language: str) -> List[str]:
        q = f'location:"{location}" type:user' + (f' language:"{language}"' if language else "")
        data = await http.json("GET", "https://api.github.com/search/users", headers=headers, cache_ttl=3600,
                               params={"q": q, "sort": "followers", "order": "desc", "per_page": per_page})
        return [item["login"] for item in (data or {}).get("items", []) if item.get("login")]

    found = await asyncio.gather(*(search(loc, lang) for loc in locations for lang in languages))
    logins: List[str] = []
    for position in range(per_page):  # interleave so every location/language contributes
        for batch in found:
            if position < len(batch) and batch[position] not in logins:
                logins.append(batch[position])
    logins = logins[: limits["github_profiles"]]
    via = f"GitHub users located in {', '.join(locations)}" + \
          (f" who code in {', '.join(l for l in languages if l)}" if any(languages) else "")

    async def profile(login: str) -> Optional[Dict[str, Any]]:
        user = await http.json("GET", f"https://api.github.com/users/{quote(login)}", headers=headers, cache_ttl=86400)
        if not user:
            return None
        bio = user.get("bio") or ""
        return {
            "title": user.get("name") or login,
            "company": (user.get("company") or "").lstrip("@").strip() or None,
            "location": user.get("location"),
            "email": user.get("email"),
            "website": website_url(user.get("blog")),
            "source": "GitHub",
            "source_url": user.get("html_url") or f"https://github.com/{login}",
            "details": {"github": login, "bio": bio, "description": bio, "hireable": user.get("hireable"),
                        "followers": user.get("followers"), "public_repos": user.get("public_repos"),
                        "twitter": user.get("twitter_username"), "matched_via": via},
            "raw": {k: user.get(k) for k in ("login", "name", "company", "blog", "location", "email", "hireable",
                                             "bio", "twitter_username", "public_repos", "followers", "html_url",
                                             "created_at", "updated_at")},
            "targeted": True,
        }

    profiles = await asyncio.gather(*(profile(login) for login in logins))
    return [p for p in profiles if p]


# ---------------------------------------------------------------- jobs
async def adzuna_jobs(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    if not (settings.ADZUNA_APP_ID and settings.ADZUNA_APP_KEY):
        return []
    limits, place = plan["limits"], plan["place"]
    countries = plan["search"]["adzuna_countries"][: limits["adzuna_countries"]]
    where = place.get("city") or place.get("region") if place.get("scope") in ("city", "region") else None

    async def one(country: str) -> List[Dict[str, Any]]:
        words = _plain_query(_job_terms(plan)).split()
        per_page = limits["adzuna_per_page"]
        base = f"https://api.adzuna.com/v1/api/jobs/{country}/search"
        params: Dict[str, Any] = {}
        data: Optional[Dict[str, Any]] = None
        # Adzuna ANDs every word, so an over-specific query returns nothing: widen step by step.
        for what in dict.fromkeys([" ".join(words), " ".join(words[:3]), " ".join(words[:2])]):
            if not what:
                continue
            params = {"app_id": settings.ADZUNA_APP_ID, "app_key": settings.ADZUNA_APP_KEY,
                      "results_per_page": per_page, "what": what, "content-type": "application/json"}
            if where:
                params["where"] = where
            if plan["filters"].get("recency_days"):
                params["max_days_old"] = plan["filters"]["recency_days"]
            data = await http.json("GET", f"{base}/1", params=params, cache_ttl=1800)
            if len((data or {}).get("results", [])) >= 10:
                break
        results = list((data or {}).get("results", []))
        for page in range(2, limits["adzuna_pages"] + 1):  # Deep reads the next page of listings too
            if len(results) < per_page * (page - 1):
                break
            more = await http.json("GET", f"{base}/{page}", params=params, cache_ttl=1800)
            results += (more or {}).get("results", [])
        currency = plan["search"]["currency"].get(country, "")
        rows = []
        for job in results:
            low, high = job.get("salary_min"), job.get("salary_max")
            salary = None
            if low or high:
                salary = " – ".join(f"{v:,.0f}" for v in dict.fromkeys(v for v in (low, high) if v)) + f" {currency}"
                if str(job.get("salary_is_predicted")) == "1":
                    salary += " (estimated)"
            rows.append({
                "title": job.get("title"),
                "company": (job.get("company") or {}).get("display_name"),
                "location": (job.get("location") or {}).get("display_name"),
                "source": "Adzuna",
                "source_url": job.get("redirect_url"),
                "details": {"salary": salary, "job_type": job.get("contract_time") or job.get("contract_type"),
                            "category": (job.get("category") or {}).get("label"), "posted": job.get("created"),
                            "description": clean_text(job.get("description"), 1500)},
                "raw": job,
                "targeted": True,
            })
        return rows

    batches = await asyncio.gather(*(one(c) for c in countries))
    return [row for rows in batches for row in rows]


def board_slugs(company: str) -> List[str]:
    name = company.strip().lower()
    slugs = []
    for slug in (re.sub(r"[^a-z0-9]", "", name), re.sub(r"[^a-z0-9]+", "-", name).strip("-")):
        if slug and slug not in slugs:
            slugs.append(slug)
    return slugs


async def _greenhouse(http: HttpClient, slug: str, company: str) -> List[Dict[str, Any]]:
    data = await http.json("GET", f"https://boards-api.greenhouse.io/v1/boards/{quote(slug)}/jobs", cache_ttl=1800)
    rows = []
    for job in (data or {}).get("jobs", []):
        location = (job.get("location") or {}).get("name")
        rows.append({"title": job.get("title"), "company": job.get("company_name") or company, "location": location,
                     "source": "Greenhouse", "source_url": job.get("absolute_url"),
                     "details": {"remote": True if location and "remote" in location.lower() else None,
                                 "posted": job.get("first_published") or job.get("updated_at")},
                     "raw": _trim(job, drop=("data_compliance",)), "targeted": False})
    return rows


async def _lever(http: HttpClient, slug: str, company: str) -> List[Dict[str, Any]]:
    data = await http.json("GET", f"https://api.lever.co/v0/postings/{quote(slug)}", params={"mode": "json"},
                           cache_ttl=1800)
    rows = []
    for post in data if isinstance(data, list) else []:
        cats = post.get("categories") or {}
        workplace = (post.get("workplaceType") or "").lower()
        rows.append({"title": post.get("text"), "company": company,
                     "location": cats.get("location") or ", ".join(cats.get("allLocations") or []) or None,
                     "source": "Lever", "source_url": post.get("hostedUrl"),
                     "details": {"remote": True if workplace == "remote" else None, "team": cats.get("team"),
                                 "department": cats.get("department"), "job_type": cats.get("commitment"),
                                 "posted": _iso_from_epoch(post.get("createdAt")),
                                 "description": clean_text(post.get("descriptionPlain"), 1500)},
                     "raw": _trim(post, drop=("description", "lists", "additional", "descriptionBody", "opening")),
                     "targeted": False})
    return rows


async def _ashby(http: HttpClient, slug: str, company: str) -> List[Dict[str, Any]]:
    data = await http.json("GET", f"https://api.ashbyhq.com/posting-api/job-board/{quote(slug)}",
                           params={"includeCompensation": "true"}, cache_ttl=1800)
    rows = []
    for job in (data or {}).get("jobs", []):
        if job.get("isListed") is False:
            continue
        workplace = (job.get("workplaceType") or "").lower()
        rows.append({"title": job.get("title"), "company": company, "location": job.get("location"),
                     "source": "Ashby", "source_url": job.get("jobUrl"),
                     "details": {"remote": True if workplace == "remote" else (False if workplace in ("hybrid", "onsite") else None),
                                 "team": job.get("team"), "department": job.get("department"),
                                 "job_type": job.get("employmentType"),
                                 "salary": (job.get("compensation") or {}).get("compensationTierSummary"),
                                 "posted": job.get("publishedAt"),
                                 "description": clean_text(job.get("descriptionPlain"), 1500)},
                     "raw": _trim(job, drop=("descriptionHtml",)), "targeted": False})
    return rows


async def ats_boards(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    companies = plan["target_companies"][: plan["limits"]["ats_companies"]]

    async def company_rows(company: str) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for fetch in (_greenhouse, _lever, _ashby):
            for slug in board_slugs(company):
                rows = await fetch(http, slug, company)
                if rows:
                    out.extend(rows)
                    break
        return out

    batches = await asyncio.gather(*(company_rows(c) for c in companies))
    return [row for rows in batches for row in rows]


async def remotive_jobs(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    data = await http.json("GET", "https://remotive.com/api/remote-jobs", params={"search": _job_terms(plan)},
                           cache_ttl=6 * 3600)
    rows = []
    for job in (data or {}).get("jobs", [])[: plan["limits"]["per_source"]]:
        rows.append({"title": job.get("title"), "company": job.get("company_name"),
                     "location": job.get("candidate_required_location"), "source": "Remotive",
                     "source_url": job.get("url"),
                     "details": {"salary": job.get("salary") or None, "remote": True, "job_type": job.get("job_type"),
                                 "category": job.get("category"), "tags": job.get("tags") or [],
                                 "posted": job.get("publication_date"),
                                 "description": html_to_text(job.get("description"))[:1500]},
                     "raw": _trim(job), "targeted": False})
    return rows


async def arbeitnow_jobs(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = []
    for page in range(1, (2 if plan["mode"] == "Deep" else 1) + 1):
        data = await http.json("GET", "https://www.arbeitnow.com/api/job-board-api", params={"page": page}, cache_ttl=3600)
        for job in (data or {}).get("data", []):
            rows.append({"title": job.get("title"), "company": job.get("company_name"), "location": job.get("location"),
                         "source": "Arbeitnow", "source_url": job.get("url"),
                         "details": {"remote": job.get("remote") if isinstance(job.get("remote"), bool) else None,
                                     "tags": job.get("tags") or [], "job_type": ", ".join(job.get("job_types") or []) or None,
                                     "posted": _iso_from_epoch(job.get("created_at")),
                                     "description": html_to_text(job.get("description"))[:1500]},
                         "raw": _trim(job), "targeted": False})
    return rows


async def hn_hiring(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    stories = await http.json("GET", "https://hn.algolia.com/api/v1/search_by_date",
                              params={"tags": "story,author_whoishiring", "hitsPerPage": 6}, cache_ttl=6 * 3600)
    story = next((h for h in (stories or {}).get("hits", []) if "who is hiring" in (h.get("title") or "").lower()), None)
    if not story:
        return []
    story_id = str(story.get("objectID"))
    data = await http.json("GET", "https://hn.algolia.com/api/v1/search", cache_ttl=1800,
                           params={"tags": f"comment,story_{story_id}", "query": _plain_query(_job_terms(plan)),
                                   "hitsPerPage": min(100, plan["limits"]["per_source"])})
    rows = []
    for hit in (data or {}).get("hits", []):
        if str(hit.get("parent_id")) != story_id:
            continue  # only top-level comments are job posts
        text = html_to_text((hit.get("comment_text") or "").replace("<p>", "\n"))
        header = text.split("\n", 1)[0][:300]
        parts = [p.strip() for p in header.split("|") if p.strip()]
        links = re.findall(r'href="([^"]+)"', hit.get("comment_text") or "")
        rows.append({"title": parts[1] if len(parts) > 1 else header[:160], "company": parts[0][:120] if len(parts) > 1 else None,
                     "location": "; ".join(parts[2:4]) or None, "source": "HN Who is hiring",
                     "source_url": f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                     "email": (extract_emails(text) or [None])[0],
                     "website": next((website_url(u) for u in links if "ycombinator.com" not in u), None),
                     "details": {"description": text[:1500], "posted": hit.get("created_at"), "thread": story.get("title")},
                     "raw": _trim(hit, drop=("_highlightResult",)), "targeted": False})
    return rows


async def hn_search(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    query = _plain_query((plan["queries"]["news"] or plan["queries"]["web"])[0])[:120]
    params: Dict[str, Any] = {"tags": "story", "query": query, "hitsPerPage": min(40, plan["limits"]["per_source"]),
                              "numericFilters": f"created_at_i>{int(time.time()) - 2 * 365 * 86400}"}
    data = await http.json("GET", "https://hn.algolia.com/api/v1/search", params=params, cache_ttl=1800)
    rows = []
    for hit in (data or {}).get("hits", []):
        if not hit.get("title"):
            continue
        hn_url = f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
        rows.append({"title": hit.get("title"), "company": None, "location": None, "source": "Hacker News",
                     "source_url": hit.get("url") or hn_url,
                     "details": {"hn_discussion": hn_url, "points": hit.get("points"), "date": hit.get("created_at"),
                                 "description": html_to_text(hit.get("story_text"))[:800] or None},
                     "raw": _trim(hit, drop=("_highlightResult",)), "targeted": False})
    return rows


async def wikipedia_search(http: HttpClient, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    query = _plain_query(plan["queries"]["web"][0]) or plan["corrected_prompt"]
    data = await http.json("GET", "https://en.wikipedia.org/w/api.php", cache_ttl=3600,
                           params={"action": "query", "list": "search", "srsearch": query[:200], "format": "json",
                                   "srlimit": 20, "srprop": "snippet|timestamp"})
    rows = []
    for item in ((data or {}).get("query") or {}).get("search", []):
        title = item.get("title") or ""
        rows.append({"title": title, "company": None, "location": None, "source": "Wikipedia",
                     "source_url": "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_")),
                     "details": {"description": html_to_text(item.get("snippet")), "updated": item.get("timestamp")},
                     "raw": item, "targeted": False})
    return rows


SOURCE_FUNCS = {
    "serper_web": serper_web, "tavily": tavily_search, "serper_places": serper_places, "serper_news": serper_news,
    "github_users": github_users, "adzuna": adzuna_jobs, "ats_boards": ats_boards, "remotive": remotive_jobs,
    "arbeitnow": arbeitnow_jobs, "hn_hiring": hn_hiring, "hn_search": hn_search, "wikipedia": wikipedia_search,
}
WEB_SOURCES = {"serper_web", "tavily"}  # these return search results that go through AI triage
