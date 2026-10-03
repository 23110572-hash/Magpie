"""Credits: new accounts start with free credits, each search costs credits by mode, packs top up instantly.

Balances only change through these helpers. Spending is one conditional UPDATE, so a balance can never go
below zero (not even with double clicks), and every change is written to the credit history.
"""
import logging
from typing import Any, Dict, List, Optional

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import CreditTransaction

logger = logging.getLogger("magpie.credits")

SIGNUP_CREDITS = 10
MODE_COSTS: Dict[str, int] = {"Fast": 1, "Balanced": 2, "Deep": 4}
# MVP: packs are added instantly, no payment provider is connected yet.
PACKS: List[Dict[str, Any]] = [
    {"id": "pack_10", "credits": 10, "price_inr": 50},
    {"id": "pack_100", "credits": 100, "price_inr": 500},
    {"id": "pack_500", "credits": 500, "price_inr": 2500},
]
PACKS_BY_ID = {pack["id"]: pack for pack in PACKS}


class InsufficientCredits(Exception):
    def __init__(self, needed: int, balance: int):
        super().__init__(f"Needs {needed} credits, balance is {balance}")
        self.needed = needed
        self.balance = balance


def cost_of(mode: Optional[str]) -> int:
    return MODE_COSTS.get(mode or "", MODE_COSTS["Balanced"])


def credits_text(amount: int) -> str:
    return f"{amount} credit{'' if amount == 1 else 's'}"


def refund_note(amount: int) -> str:
    """Sentence appended to a failed run's message, e.g. ' Your 2 credits were refunded.'"""
    if not amount:
        return ""
    return f" Your {credits_text(amount)} {'was' if amount == 1 else 'were'} refunded."


def _record(db: Session, user_id: str, delta: int, balance: int, reason: str, description: str,
            **extra: Any) -> CreditTransaction:
    tx = CreditTransaction(user_id=user_id, delta=delta, balance_after=balance, reason=reason,
                           description=description[:300], **extra)
    db.add(tx)
    return tx


def balance_of(db: Session, user_id: str) -> int:
    value = db.execute(text("SELECT credits FROM users WHERE id = :uid"), {"uid": user_id}).scalar()
    return int(value or 0)


def spend(db: Session, user_id: str, amount: int, description: str, run_id: Optional[str] = None) -> int:
    """Deduct credits inside the caller's transaction; raises InsufficientCredits instead of going negative."""
    balance = db.execute(
        text("UPDATE users SET credits = credits - :n WHERE id = :uid AND credits >= :n RETURNING credits"),
        {"n": amount, "uid": user_id}).scalar()
    if balance is None:
        raise InsufficientCredits(amount, balance_of(db, user_id))
    _record(db, user_id, -amount, int(balance), "run", description, run_id=run_id)
    return int(balance)


def grant(db: Session, user_id: str, amount: int, reason: str, description: str, **extra: Any) -> int:
    """Add credits inside the caller's transaction and return the new balance."""
    balance = db.execute(
        text("UPDATE users SET credits = COALESCE(credits, 0) + :n WHERE id = :uid RETURNING credits"),
        {"n": amount, "uid": user_id}).scalar()
    if balance is None:
        raise LookupError("User not found")
    _record(db, user_id, amount, int(balance), reason, description, **extra)
    return int(balance)


def refund_run(run_id: str, note: str) -> int:
    """Give back the credits charged for a run, exactly once. Returns how many credits were refunded."""
    with SessionLocal() as db:
        row = db.execute(text(
            "UPDATE workflow_runs SET credits_refunded = credits_charged "
            "WHERE id = :rid AND credits_refunded IS NULL AND COALESCE(credits_charged, 0) > 0 "
            "RETURNING credits_charged, user_id"), {"rid": run_id}).first()
        if row is None or not row.user_id:
            db.rollback()
            return 0
        amount = int(row.credits_charged)
        try:
            grant(db, row.user_id, amount, "refund", f"Refund: {note}", run_id=run_id)
        except LookupError:  # the account was deleted meanwhile
            db.rollback()
            return 0
        db.commit()
        logger.info("Refunded %s credits for run %s (%s)", amount, run_id, note)
        return amount


def backfill_signup_credits() -> int:
    """Accounts created before credits existed get the welcome credits, once."""
    with SessionLocal() as db:
        user_ids = [uid for (uid,) in db.execute(text("SELECT id FROM users WHERE credits IS NULL")).all()]
        granted = 0
        for uid in user_ids:
            balance = db.execute(
                text("UPDATE users SET credits = :n WHERE id = :uid AND credits IS NULL RETURNING credits"),
                {"n": SIGNUP_CREDITS, "uid": uid}).scalar()
            if balance is not None:  # another server may have done it a moment earlier
                _record(db, uid, SIGNUP_CREDITS, int(balance), "signup", "Welcome credits")
                granted += 1
        db.commit()
        return granted
