"""Cleaning, validation, keyword pre-ranking (with LLM-supplied synonyms) and entity merging."""
import html
import json
import re
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

TAG_RE = re.compile(r"<[^>]+>")
EMAIL_RE = re.compile(r"(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}(?![\w-])")
# Only bracketed "[at]" forms: a plain " at " matches ordinary English ("teams at U.S. based ...").
OBFUSCATED_EMAIL_RE = re.compile(
    r"([A-Za-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\{at\})\s*([A-Za-z0-9-]+(?:\s*(?:\.|\[dot\]|\(dot\))\s*[A-Za-z0-9-]+)+)",
    re.IGNORECASE,
)
PLACEHOLDER_PHONE_RE = re.compile(r"1234567|2345678|5551234|555555|0000000|(\d)\1{6,}")
PLACEHOLDER_EMAIL_PARTS = ("example.", "domain.com", "email.com", "yourcompany", "yourname", "sentry.io", "noreply",
                           "no-reply", "wixpress", "@2x", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", "name@",
                           "user@", "test@")


def html_to_text(value: Any) -> str:
    if not value:
        return ""
    text = str(value)
    if "&lt;" in text and "<" not in text:  # HTML-escaped HTML (Greenhouse)
        text = html.unescape(text)
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", text)
    text = re.sub(r"(?i)<br\s*/?>|</p>|</li>|</h\d>|</div>", "\n", text)
    text = TAG_RE.sub(" ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v\xa0]+", " ", text)
    return re.sub(r"\s*\n\s*", "\n", text).strip()


def clean_text(value: Any, limit: Optional[int] = None) -> str:
    if value is None:
        return ""
    text = str(value)
    if ("<" in text and ">" in text) or "&#" in text or "&amp;" in text:
        text = html_to_text(text)
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        cut = text[:limit].rsplit(" ", 1)[0]
        text = (cut or text[:limit]).rstrip(",.;: ") + "…"
    return text


def safe_url(url: Any) -> Optional[str]:
    if not url or not isinstance(url, str):
        return None
    url = url.strip()
    if len(url) > 2000:
        return None
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or " " in parsed.netloc:
        return None
    return url


def website_url(value: Any) -> Optional[str]:
    """Normalise a bare domain like 'studio.in' into https://studio.in."""
    if not value or not isinstance(value, str):
        return None
    value = value.strip()
    if value and not value.lower().startswith(("http://", "https://")) and "." in value and " " not in value:
        value = "https://" + value.lstrip("/")
    return safe_url(value)


def host_of(url: Optional[str]) -> str:
    try:
        return urlparse(url or "").netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def extract_emails(text: str, limit: int = 5) -> List[str]:
    if not text:
        return []
    plain = html.unescape(text)
    found = list(EMAIL_RE.findall(plain))
    for user, domain in OBFUSCATED_EMAIL_RE.findall(plain):
        dom = re.sub(r"\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*", ".", domain, flags=re.I).replace(" ", "")
        if "." in dom:
            found.append(f"{user}@{dom}")
    out: List[str] = []
    for email in found:
        email = email.strip(".").lower()
        if any(part in email for part in PLACEHOLDER_EMAIL_PARTS) or len(email) > 254:
            continue
        if email not in out:
            out.append(email)
    return out[:limit]


def phone_digits(value: Any) -> str:
    return re.sub(r"\D", "", str(value or ""))


def clean_phone(value: Any) -> Optional[str]:
    if not value:
        return None
    text = re.sub(r"[^\d+()\-.\s]", "", str(value)).strip()
    digits = phone_digits(text)
    if not 7 <= len(digits) <= 15 or PLACEHOLDER_PHONE_RE.search(digits):
        return None  # too short/long, or a template placeholder like +91 555 1234567
    return re.sub(r"\s+", " ", text)[:40]


def snapshot(obj: Any, limit: int = 20000) -> str:
    """Raw provenance snapshot of the exact payload the record was built from."""
    try:
        text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False, default=str, indent=1)
    except (TypeError, ValueError):
        text = str(obj)
    return text if len(text) <= limit else text[:limit] + "\n…[truncated]"


def norm(text: Any) -> str:
    text = str(text or "").lower()
    text = re.sub(r"[^\w+#.\s/-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def contains_term(text: str, term: str) -> bool:
    term = term.strip()
    if not term:
        return False
    return re.search(r"(?<![\w])" + re.escape(term) + r"(?![\w])", text) is not None


def canonical_url(url: str) -> str:
    parsed = urlparse(url)
    keep = {"gh_jid", "id", "jobid", "job_id", "jk", "curid", "cid", "query_place_id"}
    query = urlencode([(k, v) for k, v in parse_qsl(parsed.query) if k.lower() in keep])
    path = parsed.path.rstrip("/") or "/"
    return urlunparse(("", parsed.netloc.lower().removeprefix("www."), path, "", query, ""))


# ---------------------------------------------------------------- validation
def normalize_candidate(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    title = clean_text(item.get("title"), 300)
    source_url = safe_url(item.get("source_url"))
    if not title or len(title) < 2 or not source_url:
        return None
    details: Dict[str, Any] = {}
    for key, value in (item.get("details") or {}).items():
        if value is None or value == "" or value == [] or value == {}:
            continue
        if key in ("description", "snippet", "bio"):
            value = clean_text(value, 1500)
        elif isinstance(value, str):
            value = clean_text(value, 600)
        elif isinstance(value, list):
            value = [clean_text(v, 160) if isinstance(v, str) else v for v in value if v not in (None, "")][:12]
        elif isinstance(value, dict):
            value = {str(k)[:40]: (clean_text(v, 300) if isinstance(v, str) else v) for k, v in value.items()
                     if v not in (None, "", [], {}) and isinstance(v, (str, int, float, bool))}
        if value not in ("", [], {}, None):
            details[key] = value
    emails = extract_emails(" ".join([str(item.get("email") or "")] + [str(e) for e in details.get("emails") or []]))
    if emails:
        details["emails"] = emails
    else:
        details.pop("emails", None)
    return {
        "title": title,
        "company": clean_text(item.get("company"), 200) or None,
        "location": clean_text(item.get("location"), 200) or None,
        "email": emails[0] if emails else None,
        "phone": clean_phone(item.get("phone")),
        "website": website_url(item.get("website")),
        "source": item.get("source") or "Web",
        "source_url": source_url,
        "details": details,
        "raw": item.get("raw"),
        "raw_snapshot": item.get("raw_snapshot"),
        "targeted": bool(item.get("targeted", True)),
        "shared_url": bool(item.get("shared_url")),
    }


def prefilter(record: Dict[str, Any], plan: Dict[str, Any]) -> Tuple[float, int]:
    """Cheap ranking with the LLM's own synonyms and place aliases. Returns (score, groups matched)."""
    d = record["details"]
    fields = d.get("fields") if isinstance(d.get("fields"), dict) else {}
    text = norm(" ".join(str(x) for x in [
        record["title"], record.get("company") or "", record.get("location") or "", d.get("description", ""),
        d.get("snippet", ""), d.get("category", ""), d.get("bio", ""), " ".join(map(str, d.get("tags") or [])),
        d.get("department", ""), d.get("team", ""), " ".join(map(str, fields.values())),
    ]))
    groups = plan.get("match_terms") or []
    hits = sum(1 for group in groups if any(contains_term(text, norm(t)) for t in group))
    place = plan.get("place") or {}
    terms = [place.get("city"), place.get("region"), *(place.get("aliases") or [])]
    if place.get("scope") in ("country", "any") or not any(terms):
        terms += [place.get("country"), *(plan.get("cover_cities") or [])]
    place_hit = any(contains_term(text, norm(t)) for t in terms if t)
    score = (hits / len(groups) if groups else 0.5) + (0.5 if place_hit else 0.0)
    return score, hits


# ---------------------------------------------------------------- merging
def _entity_keys(record: Dict[str, Any]) -> List[str]:
    keys: List[str] = []
    if not record.get("shared_url"):
        keys.append("u:" + canonical_url(record["source_url"]))
    if record.get("email"):
        keys.append("e:" + record["email"].lower())
    digits = phone_digits(record.get("phone"))
    if len(digits) >= 8:
        keys.append("p:" + digits[-10:])
    if record.get("website"):
        keys.append("w:" + canonical_url(record["website"]))
    login = (record.get("details") or {}).get("github")
    if login:
        keys.append("g:" + str(login).lower())
    name = norm(record.get("title"))
    org, loc = norm(record.get("company")), norm(record.get("location"))
    if len(name) >= 3 and (org or loc):
        keys.append("n:" + "|".join([name, org, loc]))
    return keys


def _richness(record: Dict[str, Any]) -> float:
    return (record.get("score") or 0) / 10 + sum(1 for k in ("email", "phone", "website", "company", "location")
                                                 if record.get(k)) + 0.1 * len(record.get("details") or {})


def merge_duplicates(records: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """Union records that share a URL, e-mail, phone, website, GitHub login or name+org+place."""
    parent = list(range(len(records)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    owner: Dict[str, int] = {}
    for idx, record in enumerate(records):
        for key in _entity_keys(record):
            if key in owner:
                a, b = find(owner[key]), find(idx)
                if a != b:
                    parent[b] = a
            else:
                owner[key] = idx

    groups: Dict[int, List[int]] = defaultdict(list)
    for idx in range(len(records)):
        groups[find(idx)].append(idx)

    merged: List[Dict[str, Any]] = []
    removed = 0
    for members in groups.values():
        items = sorted((records[i] for i in members), key=_richness, reverse=True)
        base = items[0]
        removed += len(items) - 1
        emails = list(dict.fromkeys(e for it in items for e in
                                    [it.get("email"), *((it.get("details") or {}).get("emails") or [])] if e))
        phones = list(dict.fromkeys(p for it in items for p in
                                    [it.get("phone"), *((it.get("details") or {}).get("phones") or [])] if p))
        for other in items[1:]:
            for key in ("company", "location", "website", "email", "phone"):
                if not base.get(key) and other.get(key):
                    base[key] = other[key]
            for key, value in (other.get("details") or {}).items():
                if key == "fields" and isinstance(value, dict):
                    fields = base["details"].setdefault("fields", {})
                    for fk, fv in value.items():
                        fields.setdefault(fk, fv)
                else:
                    base["details"].setdefault(key, value)
        if emails:
            base["email"] = base.get("email") or emails[0]
            base["details"]["emails"] = emails[:5]
        if phones:
            base["phone"] = base.get("phone") or phones[0]
            base["details"]["phones"] = phones[:5]
        seen = [f"{o['source']}: {o['source_url']}" for o in items[1:] if o["source_url"] != base["source_url"]]
        if seen:
            base["details"]["also_seen_at"] = list(dict.fromkeys(seen + list(base["details"].get("also_seen_at") or [])))[:6]
        merged.append(base)
    return merged, removed


def coverage_of(records: List[Dict[str, Any]]) -> Dict[str, int]:
    return {
        "total": len(records),
        "with_email": sum(1 for r in records if r.get("email")),
        "with_phone": sum(1 for r in records if r.get("phone")),
        "with_website": sum(1 for r in records if r.get("website")),
        "with_any_contact": sum(1 for r in records if r.get("email") or r.get("phone")),
    }
