"""Open-web step: decide which search results to read, fetch them safely, and extract entities.

Safety: robots.txt is honoured, only public hosts on standard ports are fetched (each redirect is re-checked),
responses are size-capped, and sites whose terms forbid scraping are never fetched (their search results
can still be used). Extraction: schema.org JSON-LD first, then the LLM; URLs, e-mails and phones proposed by
the LLM are kept only if they literally appear on the page.
"""
import asyncio
import ipaddress
import json
import logging
import socket
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import unquote, urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup

from app.config import settings
from app.services.extractor import (
    clean_phone, clean_text, extract_emails, host_of, html_to_text, phone_digits, safe_url, website_url,
)
from app.services.llm import chat_json
from app.services.planner import plan_brief

logger = logging.getLogger("magpie.scraper")

MAX_BYTES = 1_500_000
NEVER_FETCH = ("linkedin.com", "naukri.com", "instagram.com", "facebook.com", "fb.com", "twitter.com", "x.com",
               "threads.net", "tiktok.com", "youtube.com", "pinterest.", "upwork.com", "fiverr.com", "glassdoor.",
               "indeed.", "quora.com", "reddit.com")
NAT64_PREFIX = ipaddress.ip_network("64:ff9b::/96")
_ROBOTS: Dict[str, RobotFileParser] = {}


def never_fetch(url: str) -> bool:
    host = host_of(url)
    for domain in NEVER_FETCH:
        if domain.endswith("."):
            if domain in host + ".":
                return True
        elif host == domain or host.endswith("." + domain):
            return True
    return False


def _effective_ip(address: str):
    ip = ipaddress.ip_address(address.split("%", 1)[0])
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped:
            return ip.ipv4_mapped
        if ip in NAT64_PREFIX:  # DNS64 networks embed IPv4 hosts in 64:ff9b::/96
            return ipaddress.IPv4Address(int(ip) & 0xFFFFFFFF)
    return ip


async def _is_public_host(host: str) -> bool:
    try:
        infos = await asyncio.to_thread(socket.getaddrinfo, host, None)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = _effective_ip(info[4][0])
        except ValueError:
            return False
        if not ip.is_global or ip.is_multicast:
            return False
    return True


class PageFetcher:
    def __init__(self, concurrency: int = 6):
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=8.0),
            follow_redirects=False,
            headers={"User-Agent": settings.HTTP_USER_AGENT, "Accept": "text/html,application/xhtml+xml",
                     "Accept-Language": "en"},
        )
        self.sem = asyncio.Semaphore(concurrency)

    async def aclose(self) -> None:
        await self.client.aclose()

    async def _robots_allows(self, url: str) -> bool:
        parsed = urlparse(url)
        base = f"{parsed.scheme}://{parsed.netloc}"
        parser = _ROBOTS.get(base)
        if parser is None:
            parser = RobotFileParser()
            try:
                res = await self.client.get(base + "/robots.txt", follow_redirects=True)
                if res.status_code == 200:
                    parser.parse(res.text.splitlines())
                elif res.status_code in (401, 403):
                    parser.disallow_all = True
                else:
                    parser.allow_all = True
            except httpx.HTTPError:
                parser.allow_all = True
            _ROBOTS[base] = parser
        return parser.can_fetch(settings.HTTP_USER_AGENT, url)

    async def fetch(self, url: str) -> Tuple[Optional[str], Optional[str], str]:
        """Returns (final_url, html, status): ok | blocked_robots | unsafe | error."""
        for _ in range(4):
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.port not in (None, 80, 443):
                return None, None, "unsafe"
            if not await _is_public_host(parsed.hostname):
                return None, None, "unsafe"
            if not await self._robots_allows(url):
                return None, None, "blocked_robots"
            try:
                async with self.sem:
                    async with self.client.stream("GET", url) as res:
                        if res.is_redirect:
                            url = urljoin(url, res.headers.get("location", ""))
                            continue
                        if res.status_code != 200 or "html" not in res.headers.get("content-type", "").lower():
                            return None, None, "error"
                        chunks, size = [], 0
                        async for chunk in res.aiter_bytes():
                            chunks.append(chunk)
                            size += len(chunk)
                            if size > MAX_BYTES:
                                break
                        return url, b"".join(chunks).decode(res.encoding or "utf-8", errors="replace"), "ok"
            except httpx.HTTPError as exc:
                logger.info("Fetching %s failed: %s", host_of(url), exc.__class__.__name__)
                return None, None, "error"
        return None, None, "error"


# ---------------------------------------------------------------- page parsing
@dataclass
class Page:
    url: str
    title: str
    text: str
    links: List[Tuple[str, str]]
    jsonld: List[Dict[str, Any]]
    emails: List[str]
    phones: List[str]
    fetched_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    next_url: Optional[str] = None  # "next page" of a paginated list on the same site


def _jsonld_objects(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    objects: List[Dict[str, Any]] = []
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or tag.get_text() or "")
        except (json.JSONDecodeError, TypeError):
            continue
        stack = [data]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
            elif isinstance(item, dict):
                graph = item.get("@graph")
                if graph:
                    stack.extend(graph if isinstance(graph, list) else [graph])
                objects.append(item)
    return objects


NEXT_LABELS = {"next", "next page", "next ›", "next »", "next >", "next →", "›", "»"}


def _next_page_url(soup: BeautifulSoup, url: str) -> Optional[str]:
    """Find the link to the next page of a paginated list (rel=next, or a 'Next' link) on the same site."""
    candidates = []
    rel_next = soup.find(["link", "a"], rel="next", href=True)
    if rel_next is not None:
        candidates.append(rel_next.get("href"))
    for anchor in soup.find_all("a", href=True):
        label = " ".join(anchor.get_text(" ", strip=True).split()).lower()
        aria = str(anchor.get("aria-label") or "").strip().lower()
        if label in NEXT_LABELS or aria.startswith("next"):
            candidates.append(anchor.get("href"))
    current = url.split("#", 1)[0]
    for href in candidates:
        absolute = safe_url(urljoin(url, str(href or "").strip()))
        if absolute and host_of(absolute) == host_of(url) and absolute.split("#", 1)[0] != current:
            return absolute
    return None


def parse_page(url: str, body: str) -> Page:
    soup = BeautifulSoup(body, "html.parser")
    jsonld = _jsonld_objects(soup)
    next_url = _next_page_url(soup, url)
    title = clean_text(soup.title.get_text(" ", strip=True) if soup.title else "", 200)
    mailtos, tels, links, seen = [], [], [], set()
    for anchor in soup.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        low = href.lower()
        if low.startswith("mailto:"):
            mailtos.append(unquote(href[7:].split("?", 1)[0]))
            continue
        if low.startswith("tel:"):
            phone = clean_phone(unquote(href[4:]))
            if phone:
                tels.append(phone)
            continue
        if low.startswith(("javascript:", "#", "data:")):
            continue
        absolute = safe_url(urljoin(url, href))
        if absolute and absolute not in seen and len(links) < 300:
            seen.add(absolute)
            links.append((clean_text(anchor.get_text(" ", strip=True), 80), absolute))
    for tag in soup(["script", "style", "noscript", "svg", "template", "iframe"]):
        tag.decompose()
    text = clean_text(soup.get_text(" ", strip=True))
    for obj in jsonld:
        for key in ("email",):
            if isinstance(obj.get(key), str):
                mailtos.append(obj[key].replace("mailto:", ""))
        if isinstance(obj.get("telephone"), str):
            phone = clean_phone(obj["telephone"])
            if phone:
                tels.append(phone)
    emails = extract_emails(" ".join(mailtos + [text]), 10)
    return Page(url=url, title=title, text=text, links=links, jsonld=jsonld, emails=emails,
                phones=list(dict.fromkeys(tels))[:5], next_url=next_url)


async def load_page(fetcher: PageFetcher, url: str) -> Tuple[Optional[Page], str]:
    if never_fetch(url):
        return None, "not_allowed"
    final_url, body, status = await fetcher.fetch(url)
    if status != "ok" or not body:
        return None, status
    try:
        return await asyncio.to_thread(parse_page, final_url, body), "ok"
    except Exception as exc:  # malformed HTML should never break a run
        logger.info("Parsing %s failed: %s", host_of(final_url), exc)
        return None, "error"


# ---------------------------------------------------------------- AI triage
TRIAGE_PROMPT = """You triage web search results for a data-collection request.
REQUEST (JSON): {brief}
For each result choose an action:
- "open": the page likely LISTS MANY relevant {entity} entries (directory, 'top N' list, marketplace/category
  page, member/partner/sponsor/exhibitor/client list, job board search page). Worth reading.
- "entity": the result itself is ONE relevant {entity} (a person's profile, a portfolio, a company or business
  site, one job posting, one event page, one article when articles are wanted).
- "skip": irrelevant, off-topic, wrong place, ads, or generic content.
Return JSON: {{"decisions": [{{"i": <index>, "action": "open"|"entity"|"skip"}}]}} covering every index."""


TRIAGE_BATCH = 40  # Deep reviews up to 160 results: split them so no reply gets cut off


async def triage_results(results: List[Dict[str, Any]], plan: Dict[str, Any]) -> Dict[int, str]:
    if not results:
        return {}
    system = TRIAGE_PROMPT.format(brief=plan_brief(plan), entity=plan["entity"])

    async def batch(offset: int) -> Dict[int, str]:
        chunk = results[offset: offset + TRIAGE_BATCH]
        items = [{"i": offset + j, "title": clean_text(r.get("title"), 140), "url": r.get("url"),
                  "snippet": clean_text(r.get("snippet"), 220)} for j, r in enumerate(chunk)]
        data = await chat_json(system, "RESULTS:\n" + json.dumps(items, ensure_ascii=False), max_tokens=1800,
                               timeout=45)
        out: Dict[int, str] = {}
        for row in (data or {}).get("decisions", []) if isinstance(data, dict) else []:
            if (isinstance(row, dict) and isinstance(row.get("i"), int) and offset <= row["i"] < offset + len(chunk)
                    and row.get("action") in ("open", "entity", "skip")):
                out[row["i"]] = row["action"]
        return out

    decisions: Dict[int, str] = {}
    for part in await asyncio.gather(*(batch(o) for o in range(0, len(results), TRIAGE_BATCH))):
        decisions.update(part)
    return decisions


# ---------------------------------------------------------------- extraction
def _name(value: Any) -> Optional[str]:
    if isinstance(value, dict):
        return str(value["name"]) if value.get("name") else None
    if isinstance(value, list) and value:
        return _name(value[0])
    if isinstance(value, str) and value and not value.startswith(("http://", "https://", "#")):
        return value
    return None


def _address(value: Any) -> Optional[str]:
    parts: List[str] = []
    for item in (value if isinstance(value, list) else [value])[:3]:
        if isinstance(item, str):
            parts.append(item)
            continue
        if not isinstance(item, dict):
            continue
        addr = item.get("address", item)
        if isinstance(addr, str):
            parts.append(addr)
        elif isinstance(addr, dict):
            text = ", ".join(str(b) for b in [addr.get("streetAddress"), addr.get("addressLocality"),
                                              addr.get("addressRegion"), _name(addr.get("addressCountry"))] if b)
            if text:
                parts.append(text)
    return "; ".join(dict.fromkeys(parts)) or None


SKIP_TYPES = {"WebPage", "WebSite", "BreadcrumbList", "ImageObject", "SearchAction", "ListItem", "SiteNavigationElement",
              "CollectionPage", "FAQPage", "Question", "Answer", "VideoObject", "Offer", "AggregateRating", "Review"}


def jsonld_candidates(page: Page, plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    site_host = host_of(page.url)
    out: List[Dict[str, Any]] = []
    for obj in page.jsonld:
        types = [obj["@type"]] if isinstance(obj.get("@type"), str) else [str(t) for t in obj.get("@type") or []]
        own_url = safe_url(obj.get("url")) if isinstance(obj.get("url"), str) else None
        base = {"source": "Web page", "raw": obj, "targeted": True, "shared_url": not own_url}
        if "JobPosting" in types:
            out.append({**base, "title": obj.get("title") or obj.get("name"), "company": _name(obj.get("hiringOrganization")),
                        "location": _address(obj.get("jobLocation")), "source_url": own_url or page.url,
                        "details": {"description": html_to_text(obj.get("description"))[:1500], "posted": obj.get("datePosted"),
                                    "job_type": _name(obj.get("employmentType")), "found_on": page.url}})
        elif "Person" in types and obj.get("name"):
            out.append({**base, "title": obj.get("name"), "company": _name(obj.get("worksFor")),
                        "location": _address(obj.get("address")), "email": obj.get("email"), "phone": obj.get("telephone"),
                        "website": own_url, "source_url": own_url or page.url,
                        "details": {"role": obj.get("jobTitle"), "description": clean_text(obj.get("description"), 600),
                                    "found_on": page.url}})
        elif "ItemList" in types:
            for element in obj.get("itemListElement") or []:
                if not isinstance(element, dict):
                    continue
                item = element.get("item") if isinstance(element.get("item"), dict) else element
                name = item.get("name") or element.get("name")
                url = safe_url(item.get("url") or element.get("url"))
                if name:
                    out.append({**base, "title": name, "company": None, "location": _address(item.get("address")),
                                "source_url": url or page.url, "shared_url": not url,
                                "website": url if url and host_of(url) != site_host else None,
                                "details": {"description": clean_text(item.get("description"), 400), "found_on": page.url},
                                "raw": element})
        elif obj.get("name") and not set(types) & SKIP_TYPES and (obj.get("address") or obj.get("telephone")):
            if own_url and host_of(own_url) == site_host and len(page.jsonld) > 3:
                continue  # the directory's own organisation block
            out.append({**base, "title": obj.get("name"), "company": obj.get("name"), "location": _address(obj.get("address")),
                        "email": obj.get("email"), "phone": obj.get("telephone"), "website": own_url,
                        "source_url": own_url or page.url,
                        "details": {"category": ", ".join(types), "description": clean_text(obj.get("description"), 600),
                                    "found_on": page.url}})
    return out


EXTRACT_PROMPT = """You extract structured rows from ONE web page for a data-collection request.
REQUEST (JSON): {brief}
Extract every {entity} listed on the page that fits the request. Skip navigation, ads, the website owner itself,
and unrelated entries. Use ONLY facts written on the page - never guess.
Return JSON: {{"items": [{{"name": "...", "organisation": string|null, "location": string|null,
  "url": the entry's own link copied exactly from LINKS or null, "email": exactly as written or null,
  "phone": exactly as written or null, "description": "max 25 words",
  "fields": {{{columns}}}}}]}}
At most 30 items. If nothing relevant is listed, return {{"items": []}}."""


async def llm_candidates(page: Page, plan: Dict[str, Any], result: Dict[str, Any]) -> List[Dict[str, Any]]:
    columns = ", ".join(f'"{c["key"]}": value or null' for c in plan["columns"])
    link_lines = "\n".join(f"{text or '-'} -> {url}" for text, url in page.links[:150])
    user = f"PAGE URL: {page.url}\nPAGE TITLE: {page.title}\n\nPAGE TEXT:\n{page.text[:12000]}\n\nLINKS:\n{link_lines}"
    data = await chat_json(EXTRACT_PROMPT.format(brief=plan_brief(plan), entity=plan["entity"], columns=columns),
                           user, max_tokens=3500, timeout=60, attempts=2)
    items = data.get("items") if isinstance(data, dict) else None
    link_set = {url for _, url in page.links}
    text_lower = page.text.lower()
    text_digits = phone_digits(page.text)
    site_host = host_of(page.url)
    excerpt = f"URL: {page.url}\nFetched: {page.fetched_at}\n\n{page.text[:2500]}"
    out: List[Dict[str, Any]] = []
    for item in (items or [])[:30]:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        url = item.get("url")
        url = urljoin(page.url, url) if isinstance(url, str) and url else None
        url = url if url in link_set else None  # only links that really exist on the page
        email = str(item.get("email") or "").strip().lower()
        email = email if email and (email in text_lower or email in page.emails) else None
        phone = clean_phone(item.get("phone"))
        if phone and phone_digits(phone) not in text_digits and phone not in page.phones:
            phone = None
        fields = {str(k)[:40]: v for k, v in (item.get("fields") or {}).items()
                  if isinstance(v, (str, int, float)) and str(v).strip()} if isinstance(item.get("fields"), dict) else {}
        out.append({
            "title": item.get("name"), "company": item.get("organisation"), "location": item.get("location"),
            "email": email, "phone": phone,
            "website": url if url and host_of(url) != site_host else None,
            "source": "Web page (AI read)", "source_url": url or page.url, "shared_url": not url,
            "details": {"description": clean_text(item.get("description"), 300), "fields": fields,
                        "found_on": page.url, "search_query": result.get("query")},
            "raw": {"extracted": item, "page": page.url},
            "raw_snapshot": json.dumps({"extracted": item}, ensure_ascii=False)[:3000] + "\n\n--- page ---\n" + excerpt,
            "targeted": True,
        })
    return out


async def extract_from_page(page: Page, plan: Dict[str, Any], result: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = jsonld_candidates(page, plan)
    if settings.llm_enabled:
        rows += await llm_candidates(page, plan, result)
    for row in rows:
        row.setdefault("raw_snapshot", None)
        if not row.get("website"):
            row["website"] = website_url(row.get("website"))
    return rows
