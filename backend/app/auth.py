"""Accounts: argon2id password hashing and signed JWT sessions."""
import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional, Tuple

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from fastapi import Header, HTTPException

from app.config import settings
from app.database import SessionLocal
from app.models import User

logger = logging.getLogger("magpie.auth")

# OWASP-recommended argon2id parameters (19 MiB, 2 iterations) - light enough for a small server.
_hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
_ALGORITHM = "HS256"
_SECRET = settings.JWT_SECRET
if not _SECRET:
    _SECRET = secrets.token_urlsafe(48)
    logger.warning("JWT_SECRET is not set: using a temporary secret, everyone is signed out on restart.")

_CACHE_TTL = 60.0
_USER_CACHE: Dict[str, Tuple[float, int, str, str]] = {}


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def create_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": user.id, "ver": user.token_version or 0, "iat": now,
               "exp": now + timedelta(days=settings.JWT_EXPIRE_DAYS)}
    return jwt.encode(payload, _SECRET, algorithm=_ALGORITHM)


def invalidate_user_cache(user_id: str) -> None:
    _USER_CACHE.pop(user_id, None)


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str
    name: str


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=401, detail=detail, headers={"WWW-Authenticate": "Bearer"})


def get_current_user(authorization: Optional[str] = Header(default=None)) -> CurrentUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise _unauthorized("Please sign in.")
    token = authorization.split(" ", 1)[1].strip()
    try:
        payload = jwt.decode(token, _SECRET, algorithms=[_ALGORITHM], options={"require": ["exp", "sub"]})
    except jwt.PyJWTError:
        raise _unauthorized("Your session has expired. Please sign in again.")
    user_id, version = str(payload["sub"]), payload.get("ver", -1)

    cached = _USER_CACHE.get(user_id)
    if cached and cached[0] > time.monotonic():
        _, token_version, email, name = cached
    else:
        with SessionLocal() as db:
            user = db.get(User, user_id)
            if user is None:
                raise _unauthorized("This account no longer exists.")
            token_version, email, name = user.token_version or 0, user.email, user.name
        _USER_CACHE[user_id] = (time.monotonic() + _CACHE_TTL, token_version, email, name)
    if token_version != version:
        raise _unauthorized("You were signed out. Please sign in again.")
    return CurrentUser(id=user_id, email=email, name=name)


def get_optional_user(authorization: Optional[str] = Header(default=None)) -> Optional[CurrentUser]:
    """Like get_current_user, but guests and bad/expired/revoked tokens get None instead of a 401."""
    if not authorization:
        return None
    try:
        return get_current_user(authorization)
    except HTTPException:
        return None
    except Exception as exc:  # e.g. a database outage must not break a public endpoint
        logger.warning("Optional sign-in check failed: %s", exc.__class__.__name__)
        return None
