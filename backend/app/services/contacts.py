"""Find published contact details (e-mail, phone) on each result's own website and contact page."""
import asyncio
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional

from app.services.extractor import host_of
from app.services.scraper import PageFetcher, load_page, never_fetch

CONTACT_LINK_RE = re.compile(r"contact|about|reach|connect|get[-_ ]?in[-_ ]?touch|kontakt|contacto|contatti|impressum|imprint",
                             re.IGNORECASE)


def _contact_target(record: Dict[str, Any]) -> Optional[tuple]:
    """(url, is_own_site). Own websites first; otherwise the entity's own page (not a shared list page)."""
    if record.get("website") and not never_fetch(record["website"]):
        return record["website"], True
    if not record.get("shared_url") and record.get("source") not in ("GitHub", "Google Maps") \
            and not never_fetch(record["source_url"]):
        return record["source_url"], False
    return None


async def enrich_contacts(fetcher: PageFetcher, records: List[Dict[str, Any]], limit: int,
                          on_progress: Optional[Callable[[int, int], Awaitable[None]]] = None) -> Dict[str, int]:
    targets = [r for r in records if not r.get("email") and _contact_target(r)][:limit]
    stats = {"checked": len(targets), "emails_found": 0, "phones_found": 0}
    done = 0

    async def one(record: Dict[str, Any]) -> None:
        nonlocal done
        url, own_site = _contact_target(record)
        page, _ = await load_page(fetcher, url)
        pages = [page] if page else []
        if page and not page.emails:
            link = next((u for text, u in page.links
                         if host_of(u) == host_of(page.url) and (CONTACT_LINK_RE.search(text) or CONTACT_LINK_RE.search(u))), None)
            if link:
                contact_page, _ = await load_page(fetcher, link)
                if contact_page:
                    pages.append(contact_page)
        emails: List[str] = []
        phones: List[str] = []
        for p in pages:
            site = host_of(p.url)
            for email in p.emails:
                # On a third-party profile page the platform's own address is not the entity's contact.
                if not own_site and email.split("@")[-1].endswith(site):
                    continue
                emails.append(email)
            phones.extend(p.phones)
        emails, phones = list(dict.fromkeys(emails)), list(dict.fromkeys(phones))
        if emails:
            record["email"] = emails[0]
            record["details"]["emails"] = list(dict.fromkeys(list(record["details"].get("emails") or []) + emails))[:5]
            record["details"]["contact_source"] = pages[-1].url if len(pages) > 1 else pages[0].url
            stats["emails_found"] += 1
        if phones and not record.get("phone"):
            record["phone"] = phones[0]
            record["details"]["phones"] = phones[:5]
            record["details"].setdefault("contact_source", pages[0].url)
            stats["phones_found"] += 1
        done += 1
        if on_progress:
            await on_progress(done, len(targets))

    await asyncio.gather(*(one(r) for r in targets))
    return stats
