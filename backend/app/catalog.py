"""Markets, intents and the catalog of permitted data sources the AI planner chooses from."""
from typing import Dict, List

INTENTS = ["people", "jobs", "companies", "local_businesses", "events", "news", "market", "other"]
INTENT_LABELS = {
    "people": "People", "jobs": "Jobs", "companies": "Companies", "local_businesses": "Local businesses",
    "events": "Events & sponsors", "news": "News", "market": "Market data", "other": "Other",
}

# ISO code -> English name (the names double as Tavily's `country` values).
EU_COUNTRIES: Dict[str, str] = {
    "at": "austria", "be": "belgium", "bg": "bulgaria", "hr": "croatia", "cy": "cyprus", "cz": "czech republic",
    "dk": "denmark", "ee": "estonia", "fi": "finland", "fr": "france", "de": "germany", "gr": "greece",
    "hu": "hungary", "ie": "ireland", "it": "italy", "lv": "latvia", "lt": "lithuania", "lu": "luxembourg",
    "mt": "malta", "nl": "netherlands", "pl": "poland", "pt": "portugal", "ro": "romania", "sk": "slovakia",
    "si": "slovenia", "es": "spain", "se": "sweden",
}
ADZUNA_COUNTRIES = {"gb", "us", "at", "au", "be", "br", "ca", "ch", "de", "es", "fr", "in", "it", "mx", "nl",
                    "nz", "pl", "sg", "za"}
ADZUNA_CURRENCY = {"in": "INR", "us": "USD", "gb": "GBP", "ca": "CAD", "au": "AUD", "sg": "SGD", "ch": "CHF",
                   "pl": "PLN", "br": "BRL", "mx": "MXN", "nz": "NZD", "za": "ZAR"}

MARKETS: Dict[str, Dict] = {
    "IN": {"label": "India", "country": "India", "code": "in", "gl": "in", "tavily": "india", "adzuna": ["in"]},
    "US": {"label": "United States", "country": "United States", "code": "us", "gl": "us",
           "tavily": "united states", "adzuna": ["us"]},
    "EU": {"label": "European Union", "country": "Europe", "code": None, "gl": None, "tavily": None,
           "adzuna": ["de", "fr", "nl", "es", "it", "at", "be", "pl"]},
}

SOURCES: Dict[str, Dict[str, object]] = {
    "serper_web": {"label": "Google search", "requires": "serper",
                   "description": "Google web results: directories, 'top N' lists, profiles (LinkedIn, Behance...), company sites, articles"},
    "serper_places": {"label": "Google Maps", "requires": "serper",
                      "description": "Google Maps listings of businesses, studios, agencies, clinics, shops and independent professionals, with phone, website, rating"},
    "serper_news": {"label": "Google News", "requires": "serper", "description": "Recent news articles"},
    "tavily": {"label": "Tavily", "requires": "tavily", "description": "AI web search that returns page content"},
    "github_users": {"label": "GitHub profiles", "requires": None,
                     "description": "Public GitHub profiles of software developers filtered by city/country and programming language"},
    "adzuna": {"label": "Adzuna jobs", "requires": "adzuna",
               "description": "Job listings aggregator (India, US, UK and major EU countries)"},
    "ats_boards": {"label": "Company job boards", "requires": None,
                   "description": "Official Greenhouse / Lever / Ashby job boards of named companies"},
    "remotive": {"label": "Remotive", "requires": None, "description": "Remote job listings worldwide"},
    "arbeitnow": {"label": "Arbeitnow", "requires": None, "description": "Job listings in Germany / Europe"},
    "hn_hiring": {"label": "HN Who is hiring", "requires": None,
                  "description": "Monthly Hacker News hiring thread (startups, mostly US / remote)"},
    "hn_search": {"label": "Hacker News", "requires": None, "description": "Tech news, launches and funding stories"},
    "wikipedia": {"label": "Wikipedia", "requires": None,
                  "description": "Encyclopedia entries about companies, organisations and topics"},
}

# Always-on sources per intent (the planner may add more).
CORE_SOURCES: Dict[str, List[str]] = {
    "people": ["serper_web", "tavily"],
    "jobs": ["adzuna", "serper_web", "tavily"],
    "companies": ["serper_web", "tavily"],
    "local_businesses": ["serper_places", "serper_web", "tavily"],
    "events": ["serper_web", "tavily"],
    "news": ["serper_news", "tavily"],
    "market": ["serper_web", "tavily"],
    "other": ["serper_web", "tavily"],
}


def normalize_sources(values) -> List[str]:
    out: List[str] = []
    for value in values or []:
        key = str(value).strip().lower().replace(" ", "_").replace("-", "_")
        if key in SOURCES and key not in out:
            out.append(key)
    return out
