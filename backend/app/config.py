import os
from pathlib import Path
from typing import List

from dotenv import load_dotenv
from pydantic import BaseModel

# Always load backend/.env, regardless of the directory the server is started from.
BACKEND_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BACKEND_DIR / ".env")


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name, str(default)))
    except ValueError:
        return default


def _env_list(name: str, default: str) -> List[str]:
    return [item.strip().rstrip("/") for item in _env(name, default).split(",") if item.strip()]


class Settings(BaseModel):
    # Storage: Neon Postgres is the only database.
    DATABASE_URL: str = _env("DATABASE_URL")

    # The LLM "brain" (OpenRouter).
    OPENROUTER_API_KEY: str = _env("OPENROUTER_API_KEY")
    OPENROUTER_MODEL: str = _env("OPENROUTER_MODEL", "meta-llama/llama-3.3-70b-instruct")
    # How OpenRouter picks among providers hosting the model: throughput | latency | price
    OPENROUTER_PROVIDER_SORT: str = _env("OPENROUTER_PROVIDER_SORT", "throughput")

    # Data sources
    SERPER_API_KEY: str = _env("SERPER_API_KEY")
    TAVILY_API_KEY: str = _env("TAVILY_API_KEY")
    ADZUNA_APP_ID: str = _env("ADZUNA_APP_ID")
    ADZUNA_APP_KEY: str = _env("ADZUNA_APP_KEY")
    GITHUB_TOKEN: str = _env("GITHUB_TOKEN")
    HTTP_USER_AGENT: str = _env(
        "HTTP_USER_AGENT", "Magpie-DataIntelligence/2.0 (+https://localhost; research prototype)"
    )

    # Accounts
    JWT_SECRET: str = _env("JWT_SECRET")
    JWT_EXPIRE_DAYS: int = _env_int("JWT_EXPIRE_DAYS", 7)

    # Server
    HOST: str = _env("HOST", "127.0.0.1")
    PORT: int = _env_int("PORT", 8008)
    CORS_ORIGINS: List[str] = _env_list("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173")
    CORS_ORIGIN_REGEX: str = _env("CORS_ORIGIN_REGEX")

    # Outreach e-mail. Render blocks SMTP, so production relays through the Vercel function;
    # locally the backend can send straight through Gmail with an app password.
    EMAIL_RELAY_URL: str = _env("EMAIL_RELAY_URL")
    EMAIL_RELAY_SECRET: str = _env("EMAIL_RELAY_SECRET")
    GMAIL_USER: str = _env("GMAIL_USER")
    GMAIL_APP_PASSWORD: str = _env("GMAIL_APP_PASSWORD").replace(" ", "")

    @property
    def llm_enabled(self) -> bool:
        return bool(self.OPENROUTER_API_KEY)

    @property
    def email_mode(self) -> str:
        if self.EMAIL_RELAY_URL and self.EMAIL_RELAY_SECRET:
            return "relay"
        if self.GMAIL_USER and self.GMAIL_APP_PASSWORD:
            return "direct"
        return "simulated"


settings = Settings()
