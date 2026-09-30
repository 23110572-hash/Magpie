"""OpenRouter client that always returns parsed JSON (or None when every attempt fails)."""
import asyncio
import contextvars
import json
import logging
import re
from typing import Any, Dict, Optional

import httpx

from app.config import settings

logger = logging.getLogger("magpie.llm")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.IGNORECASE)
_SEM = asyncio.Semaphore(8)  # parallel LLM calls per process

# Per-run token/cost accounting (set by the orchestrator, shared by all tasks of that run).
USAGE: contextvars.ContextVar[Optional[Dict[str, float]]] = contextvars.ContextVar("magpie_llm_usage", default=None)


def new_usage() -> Dict[str, float]:
    return {"calls": 0, "failed_calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "cost_usd": 0.0}


def extract_json(text: str) -> Optional[Any]:
    """Parse JSON from an LLM reply, tolerating markdown fences and surrounding prose."""
    if not text:
        return None
    cleaned = _FENCE_RE.sub("", text.strip()).strip()
    try:
        return json.loads(cleaned)
    except (json.JSONDecodeError, ValueError):
        pass
    for opener, closer in (("{", "}"), ("[", "]")):
        start = cleaned.find(opener)
        while start != -1:
            depth, in_str, escape = 0, False, False
            for idx in range(start, len(cleaned)):
                ch = cleaned[idx]
                if in_str:
                    if escape:
                        escape = False
                    elif ch == "\\":
                        escape = True
                    elif ch == '"':
                        in_str = False
                    continue
                if ch == '"':
                    in_str = True
                elif ch == opener:
                    depth += 1
                elif ch == closer:
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(cleaned[start:idx + 1])
                        except (json.JSONDecodeError, ValueError):
                            break
            start = cleaned.find(opener, start + 1)
    return None


def _record_usage(usage: Any, failed: bool = False) -> None:
    bucket = USAGE.get()
    if bucket is None:
        return
    bucket["calls"] += 1
    if failed:
        bucket["failed_calls"] += 1
    if isinstance(usage, dict):
        bucket["prompt_tokens"] += int(usage.get("prompt_tokens") or 0)
        bucket["completion_tokens"] += int(usage.get("completion_tokens") or 0)
        try:
            bucket["cost_usd"] = round(bucket["cost_usd"] + float(usage.get("cost") or 0), 6)
        except (TypeError, ValueError):
            pass


async def chat_json(system: str, user: str, *, max_tokens: int = 2000, temperature: float = 0.1,
                    timeout: float = 45.0, attempts: int = 3) -> Optional[Any]:
    """Ask the model for a JSON object. Retries on rate limits, server errors, timeouts and bad JSON."""
    if not settings.llm_enabled:
        return None
    payload: Dict[str, Any] = {
        "model": settings.OPENROUTER_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "response_format": {"type": "json_object"},
        # Only route to providers that honour JSON mode; prefer the fastest one.
        "provider": {"require_parameters": True, "sort": settings.OPENROUTER_PROVIDER_SORT},
        "usage": {"include": True},
    }
    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": settings.CORS_ORIGINS[0] if settings.CORS_ORIGINS else "http://localhost:5173",
        "X-Title": "Magpie Data Intelligence",
    }
    async with _SEM:
        async with httpx.AsyncClient(timeout=timeout) as client:
            for attempt in range(1, attempts + 1):
                try:
                    res = await client.post(OPENROUTER_URL, headers=headers, json=payload)
                except httpx.HTTPError as exc:
                    logger.warning("OpenRouter call failed (attempt %s): %s", attempt, exc.__class__.__name__)
                    await asyncio.sleep(1.5 * attempt)
                    continue
                if res.status_code in (401, 402, 403):
                    logger.error("OpenRouter rejected the request (%s): %s", res.status_code, res.text[:200])
                    _record_usage(None, failed=True)
                    return None
                if res.status_code == 400 and "usage" in payload:
                    # Older/limited routing: retry with the minimal parameter set.
                    logger.warning("OpenRouter 400, retrying with minimal parameters: %s", res.text[:200])
                    payload.pop("usage", None)
                    payload["provider"] = {"require_parameters": True}
                    continue
                if res.status_code != 200:
                    logger.warning("OpenRouter HTTP %s (attempt %s): %s", res.status_code, attempt, res.text[:200])
                    await asyncio.sleep(1.5 * attempt)
                    continue
                data: Dict[str, Any] = {}
                try:
                    data = res.json()
                    content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
                except (ValueError, AttributeError, IndexError):
                    content = ""
                parsed = extract_json(content)
                _record_usage(data.get("usage"), failed=parsed is None)
                if parsed is not None:
                    return parsed
                logger.warning("LLM reply was not JSON (attempt %s): %r", attempt, content[:160])
    return None
