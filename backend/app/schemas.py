import re
from datetime import datetime, timezone
from typing import Annotated, Any, Dict, List, Literal, Optional

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, PlainSerializer, field_validator

Mode = Literal["Fast", "Balanced", "Deep"]
Country = Literal["IN", "US", "EU"]
Intent = Literal["people", "jobs", "companies", "local_businesses", "events", "news", "market", "other"]
EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")


def _iso_utc(value: Optional[datetime]) -> Optional[str]:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


UtcDatetime = Annotated[Optional[datetime], PlainSerializer(_iso_utc, return_type=Optional[str])]


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


def clean_email(value: Optional[str], required: bool = False) -> Optional[str]:
    value = (value or "").strip().lower()
    if not value:
        if required:
            raise ValueError("E-mail is required")
        return None
    if len(value) > 254 or not EMAIL_RE.match(value):
        raise ValueError("Enter a valid e-mail address")
    return value


# ---------------------------------------------------------------- auth
class RegisterRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=8, max_length=128)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Name is required")
        return value

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return clean_email(value, required=True)


class LoginRequest(BaseModel):
    email: str = Field(..., max_length=254)
    password: str = Field(..., min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _email(cls, value: str) -> str:
        return value.strip().lower()


class UserSchema(ORMModel):
    id: str
    email: str
    name: str
    created_at: UtcDatetime = None


class AuthResponse(BaseModel):
    token: str
    user: UserSchema


class ProfileUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)

    @field_validator("name")
    @classmethod
    def _name(cls, value: str) -> str:
        value = " ".join(value.split())
        if not value:
            raise ValueError("Name is required")
        return value


class PasswordChange(BaseModel):
    current_password: str = Field(..., min_length=1, max_length=128)
    new_password: str = Field(..., min_length=8, max_length=128)


class AccountDelete(BaseModel):
    password: str = Field(..., min_length=1, max_length=128)


# ---------------------------------------------------------------- runs
class RunCreateRequest(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=2000)
    mode: Mode = "Balanced"
    country: Country = "IN"
    intent: Optional[Intent] = None

    @field_validator("prompt")
    @classmethod
    def _prompt(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 3:
            raise ValueError("Describe what you need in a few words")
        return value


class RerunRequest(BaseModel):
    intent: Optional[Intent] = None


class WorkflowRunSchema(ORMModel):
    id: str
    prompt: str
    mode: Optional[str] = "Balanced"
    country: Optional[str] = "IN"
    intent_override: Optional[str] = None
    status: str
    step: str
    progress: float = 0.0
    eta_seconds: int = 0
    message: Optional[str] = None
    spec: Dict[str, Any] = {}
    stats: Dict[str, Any] = {}
    created_at: UtcDatetime = None
    updated_at: UtcDatetime = None
    finished_at: UtcDatetime = None

    @field_validator("spec", "stats", mode="before")
    @classmethod
    def _dicts(cls, value: Any) -> Any:
        return value or {}

    @field_validator("progress", "eta_seconds", mode="before")
    @classmethod
    def _numbers(cls, value: Any) -> Any:
        return value or 0


# ---------------------------------------------------------------- datasets
class RecordSchema(ORMModel):
    id: str
    dataset_id: Optional[str] = None
    title: Optional[str] = None
    company: Optional[str] = None
    location: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    website: Optional[str] = None
    score: Optional[float] = None
    source: Optional[str] = None
    source_url: Optional[str] = None
    details: Dict[str, Any] = {}
    created_at: UtcDatetime = None

    @field_validator("details", mode="before")
    @classmethod
    def _dict(cls, value: Any) -> Any:
        return value or {}


class RecordDetailSchema(RecordSchema):
    raw_snapshot: Optional[str] = None


class DatasetSchema(ORMModel):
    id: str
    workflow_run_id: Optional[str] = None
    name: str
    category: Optional[str] = None
    intent: Optional[str] = None
    label: Optional[str] = None
    country: Optional[str] = None
    place: Dict[str, Any] = {}
    columns: List[Dict[str, Any]] = Field(default_factory=list, validation_alias=AliasChoices("column_defs", "columns"))
    coverage: Dict[str, Any] = {}
    row_count: int = 0
    created_at: UtcDatetime = None

    @field_validator("place", "coverage", mode="before")
    @classmethod
    def _dicts(cls, value: Any) -> Any:
        return value or {}

    @field_validator("columns", mode="before")
    @classmethod
    def _list(cls, value: Any) -> Any:
        return value or []


# ---------------------------------------------------------------- leads
class LeadsFromRecordsRequest(BaseModel):
    record_ids: List[str] = Field(..., min_length=1, max_length=500)


class LeadUpdateRequest(BaseModel):
    contact_name: Optional[str] = Field(default=None, min_length=1, max_length=300)
    email: Optional[str] = Field(default=None, max_length=254)
    phone: Optional[str] = Field(default=None, max_length=64)
    role: Optional[str] = Field(default=None, max_length=300)

    @field_validator("email")
    @classmethod
    def _email(cls, value: Optional[str]) -> Optional[str]:
        return clean_email(value)


class LeadSendRequest(BaseModel):
    template_subject: str = Field(..., min_length=1, max_length=300)
    template_body: str = Field(..., min_length=1, max_length=10000)


class DraftRequest(BaseModel):
    dataset_id: Optional[str] = None
    goal: Optional[str] = Field(default=None, max_length=500)


class LeadSchema(ORMModel):
    id: str
    record_id: Optional[str] = None
    dataset_id: Optional[str] = None
    contact_name: str
    email: Optional[str] = None
    phone: Optional[str] = None
    company: Optional[str] = None
    role: Optional[str] = None
    website: Optional[str] = None
    source_url: Optional[str] = None
    status: str
    template_subject: Optional[str] = None
    template_body: Optional[str] = None
    last_error: Optional[str] = None
    message_id: Optional[str] = None
    created_at: UtcDatetime = None
    sent_at: UtcDatetime = None
