import asyncio
import csv
import io
import json
import logging
import re
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import delete, func, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth import (
    CurrentUser, create_token, get_current_user, get_optional_user, hash_password, invalidate_user_cache,
    verify_password,
)
from app.catalog import INTENT_LABELS, MARKETS, SOURCES
from app.config import settings
from app.credits import (
    MODE_COSTS, PACKS, PACKS_BY_ID, SIGNUP_CREDITS, InsufficientCredits, backfill_signup_credits, balance_of, cost_of,
    credits_text, grant, refund_note, refund_run, spend,
)
from app.database import SessionLocal, get_db, init_db
from app.models import CreditTransaction, DataRecord, Dataset, LeadOutreach, User, WorkflowRun
from app.schemas import (
    AccountDelete, AuthResponse, BuyCreditsRequest, CreditTransactionSchema, DatasetSchema, DraftRequest, LeadSchema,
    LeadSendRequest, LeadsFromRecordsRequest, LeadUpdateRequest, LoginRequest, PasswordChange, ProfileUpdate,
    RecordDetailSchema, RecordSchema, RegisterRequest, RerunRequest, RunCreateRequest, SuggestionsResponse, UserSchema,
    WorkflowRunSchema,
)
from app.services.llm import chat_json
from app.services.mailer import DEFAULT_BODY, DEFAULT_SUBJECT, deliver, render_template, with_footer
from app.services.orchestrator import TERMINAL_STATUSES, begin_shutdown, run_pipeline_orchestrator
from app.services.suggestions import invalidate_user_suggestions, suggestions_for

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
logger = logging.getLogger("magpie.api")

RUNNING_TASKS: Dict[str, asyncio.Task] = {}
LATEST_STATE: Dict[str, Dict[str, Any]] = {}
SUBSCRIBERS: Dict[str, List[asyncio.Queue]] = {}


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


STALE_RUN_SECONDS = 180  # a live run writes a heartbeat at least every 45 s
SWEEP_EVERY_SECONDS = 60


def recover_stale_runs(exclude: set) -> int:
    """Fail runs that stopped reporting (the server restarted mid-run) and refund their credits.

    Runs owned by this process are excluded, and a run only counts as stale after several missed heartbeats, so
    servers sharing one database (e.g. Render and a local copy) never fail each other's live runs."""
    cutoff = _utcnow() - timedelta(seconds=STALE_RUN_SECONDS)
    with SessionLocal() as db:
        stale = (db.query(WorkflowRun)
                 .filter(WorkflowRun.status.in_(["pending", "running"]), WorkflowRun.updated_at < cutoff).all())
        interrupted: List[str] = []
        for run in stale:
            if run.id in exclude:
                continue
            run.status, run.step, run.eta_seconds, run.finished_at = "failed", "failed", 0, _utcnow()
            run.message = "Interrupted: the server restarted during this run. Run it again from History."
            interrupted.append(run.id)
        db.commit()
        # Failed runs whose refund did not go through at the time (e.g. a database hiccup).
        unrefunded = [rid for (rid,) in db.query(WorkflowRun.id).filter(
            WorkflowRun.status == "failed", WorkflowRun.credits_charged > 0,
            WorkflowRun.credits_refunded.is_(None)).all()]
    for run_id in dict.fromkeys(interrupted + unrefunded):
        amount = refund_run(run_id, "the search was interrupted" if run_id in interrupted else "the search failed")
        if amount and run_id in interrupted:
            with SessionLocal() as db:
                run = db.get(WorkflowRun, run_id)
                if run is not None:
                    run.message = (run.message or "") + refund_note(amount)
                    db.commit()
    return len(interrupted)


async def _sweep_stale_runs() -> None:
    while True:
        try:
            recovered = await asyncio.to_thread(recover_stale_runs, set(RUNNING_TASKS))
            if recovered:
                logger.info("Marked %s interrupted run(s) as failed", recovered)
        except Exception:
            logger.exception("Stale-run sweep failed")
        await asyncio.sleep(SWEEP_EVERY_SECONDS)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await asyncio.to_thread(init_db)
    granted = await asyncio.to_thread(backfill_signup_credits)
    if granted:
        logger.info("Gave welcome credits to %s existing account(s)", granted)
    sweeper = asyncio.create_task(_sweep_stale_runs())
    yield
    sweeper.cancel()
    begin_shutdown()  # runs cut off by this shutdown are failed and refunded, not "cancelled by you"
    for task in list(RUNNING_TASKS.values()):
        task.cancel()
    if RUNNING_TASKS:
        await asyncio.wait(list(RUNNING_TASKS.values()), timeout=5)


app = FastAPI(title="Magpie Data Intelligence Platform", version="2.0.0", lifespan=lifespan,
              description="Plain-English requests in, clean source-backed datasets out.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_origin_regex=settings.CORS_ORIGIN_REGEX or None,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization"],
    expose_headers=["Content-Disposition"],
)


# ---------------------------------------------------------------- meta
@app.get("/")
def health_check(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        database = "ok"
    except Exception as exc:
        database = f"error: {exc.__class__.__name__}"
    return {"status": "online", "service": "Magpie", "version": app.version, "database": database, "docs": "/docs"}


@app.get("/api/config")
def public_config():
    return {"version": app.version, "countries": [{"code": k, "label": v["label"]} for k, v in MARKETS.items()],
            "modes": ["Fast", "Balanced", "Deep"], "intents": INTENT_LABELS, "credit_costs": MODE_COSTS,
            "signup_credits": SIGNUP_CREDITS, "credit_packs": PACKS}


@app.get("/api/suggestions", response_model=SuggestionsResponse)
async def prompt_suggestions(market: str = Query("IN"), user: Optional[CurrentUser] = Depends(get_optional_user)):
    """Example requests for the prompt bar, written by the AI for the selected market (and, when signed in, from
    your own recent searches). Free: never charges credits. Always answers, with templates as fallback."""
    return await suggestions_for(market, user.id if user else None)


@app.get("/api/status")
def system_status(user: CurrentUser = Depends(get_current_user)):
    keys = {"openrouter": settings.llm_enabled, "serper": bool(settings.SERPER_API_KEY),
            "tavily": bool(settings.TAVILY_API_KEY), "adzuna": bool(settings.ADZUNA_APP_ID and settings.ADZUNA_APP_KEY),
            "github": bool(settings.GITHUB_TOKEN)}
    sources = [{"key": k, "label": v["label"], "description": v["description"],
                "available": keys.get(str(v.get("requires")), True) if v.get("requires") else True}
               for k, v in SOURCES.items()]
    return {"llm": {"enabled": settings.llm_enabled, "model": settings.OPENROUTER_MODEL},
            "keys": keys, "sources": sources,
            "email": {"mode": settings.email_mode,
                      "from": settings.GMAIL_USER or None, "reply_to": user.email}}


# ---------------------------------------------------------------- accounts
def _auth_payload(user: User) -> Dict[str, Any]:
    return AuthResponse(token=create_token(user), user=UserSchema.model_validate(user)).model_dump(mode="json")


@app.post("/api/auth/register", status_code=201)
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    taken = HTTPException(status_code=409, detail="An account with this e-mail already exists. Sign in instead.")
    if db.query(User).filter(User.email == req.email).first():
        raise taken
    user = User(email=req.email, name=req.name, password_hash=hash_password(req.password), last_login_at=_utcnow(),
                credits=SIGNUP_CREDITS)
    db.add(user)
    try:
        db.flush()
    except IntegrityError:  # the same e-mail registered a moment ago in another request
        db.rollback()
        raise taken
    db.add(CreditTransaction(user_id=user.id, delta=SIGNUP_CREDITS, balance_after=SIGNUP_CREDITS, reason="signup",
                             description="Welcome credits"))
    db.commit()
    db.refresh(user)
    return _auth_payload(user)


@app.post("/api/auth/login")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email).first()
    if not user or not verify_password(user.password_hash, req.password):
        raise HTTPException(status_code=401, detail="Wrong e-mail or password.")
    user.last_login_at = _utcnow()
    db.commit()
    return _auth_payload(user)


@app.get("/api/auth/me", response_model=UserSchema)
def me(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.get(User, user.id)


@app.patch("/api/auth/me", response_model=UserSchema)
def update_me(req: ProfileUpdate, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(User, user.id)
    row.name = req.name
    db.commit()
    invalidate_user_cache(user.id)
    return row


@app.post("/api/auth/change-password")
def change_password(req: PasswordChange, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(User, user.id)
    if not verify_password(row.password_hash, req.current_password):
        raise HTTPException(status_code=400, detail="Your current password is not correct.")
    row.password_hash = hash_password(req.new_password)
    row.token_version = (row.token_version or 0) + 1  # every other session is signed out
    db.commit()
    invalidate_user_cache(user.id)
    return _auth_payload(row)


@app.post("/api/auth/logout-all", status_code=204)
def logout_all(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    row = db.get(User, user.id)
    row.token_version = (row.token_version or 0) + 1
    db.commit()
    invalidate_user_cache(user.id)
    return Response(status_code=204)


@app.delete("/api/auth/me", status_code=204)
async def delete_account(req: AccountDelete, user: CurrentUser = Depends(get_current_user)):
    def work() -> List[str]:
        with SessionLocal() as db:
            row = db.get(User, user.id)
            if not verify_password(row.password_hash, req.password):
                raise HTTPException(status_code=400, detail="Password is not correct.")
            run_ids = [r for (r,) in db.query(WorkflowRun.id).filter(WorkflowRun.user_id == user.id).all()]
            db.execute(delete(User).where(User.id == user.id))  # runs, datasets, records, leads cascade in Postgres
            db.commit()
            return run_ids

    for run_id in await asyncio.to_thread(work):
        task = RUNNING_TASKS.get(run_id)
        if task:
            task.cancel()
    invalidate_user_suggestions(user.id)
    invalidate_user_cache(user.id)
    return Response(status_code=204)


# ---------------------------------------------------------------- credits
@app.get("/api/credits")
def get_credits(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    history = (db.query(CreditTransaction).filter(CreditTransaction.user_id == user.id)
               .order_by(CreditTransaction.created_at.desc(), CreditTransaction.id.desc()).limit(50).all())
    return {"balance": balance_of(db, user.id), "costs": MODE_COSTS, "packs": PACKS, "signup_credits": SIGNUP_CREDITS,
            "history": [CreditTransactionSchema.model_validate(t).model_dump(mode="json") for t in history]}


@app.post("/api/credits/buy")
def buy_credits(req: BuyCreditsRequest, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    """MVP: the pack is added straight away - no payment provider is connected yet."""
    pack = PACKS_BY_ID.get(req.pack_id)
    if pack is None:
        raise HTTPException(status_code=400, detail="Unknown credit pack.")
    balance = grant(db, user.id, pack["credits"], "purchase",
                    f"Bought {credits_text(pack['credits'])} for ₹{pack['price_inr']:,}",
                    pack_id=pack["id"], amount_inr=pack["price_inr"])
    db.commit()
    return {"balance": balance, "added": pack["credits"]}


# ---------------------------------------------------------------- live updates
async def broadcast_status(state: Dict[str, Any]) -> None:
    run_id = state["run_id"]
    LATEST_STATE[run_id] = state
    for queue in list(SUBSCRIBERS.get(run_id, [])):
        queue.put_nowait(state)
    if state.get("status") in TERMINAL_STATUSES:
        LATEST_STATE.pop(run_id, None)


def _spawn_run(run: WorkflowRun) -> None:
    task = asyncio.create_task(
        run_pipeline_orchestrator(run.id, run.user_id, run.prompt, run.mode or "Balanced", run.country or "IN",
                                  run.intent_override, broadcast_status),
        name=f"magpie-run-{run.id}",
    )
    RUNNING_TASKS[run.id] = task
    task.add_done_callback(lambda _t, rid=run.id: RUNNING_TASKS.pop(rid, None))


def _own_run(db: Session, run_id: str, user: CurrentUser) -> WorkflowRun:
    run = db.get(WorkflowRun, run_id)
    if not run or run.user_id != user.id:
        raise HTTPException(status_code=404, detail="Run not found")
    return run


# ---------------------------------------------------------------- runs
@app.post("/api/runs", response_model=WorkflowRunSchema, status_code=201)
async def create_run(req: RunCreateRequest, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    cost = cost_of(req.mode)
    run = WorkflowRun(user_id=user.id, prompt=req.prompt, mode=req.mode, country=req.country,
                      intent_override=req.intent, status="running", step="planning", progress=1.0, eta_seconds=0,
                      message="Starting…", spec={}, stats={}, credits_charged=cost)
    db.add(run)
    db.flush()
    try:  # the run and its charge are saved together, or not at all
        spend(db, user.id, cost, f"{req.mode} search: {req.prompt[:80]}", run_id=run.id)
    except InsufficientCredits as exc:
        db.rollback()
        raise HTTPException(status_code=402, detail=(
            f"A {req.mode} search needs {credits_text(cost)}, but you have {exc.balance}. "
            "Buy more on the Credits page."))
    db.commit()
    invalidate_user_suggestions(user.id)  # their next suggestions follow this search
    db.refresh(run)
    _spawn_run(run)
    return run


@app.get("/api/runs", response_model=List[WorkflowRunSchema])
def list_runs(limit: int = Query(100, ge=1, le=500), user: CurrentUser = Depends(get_current_user),
              db: Session = Depends(get_db)):
    return (db.query(WorkflowRun).filter(WorkflowRun.user_id == user.id)
            .order_by(WorkflowRun.created_at.desc()).limit(limit).all())


@app.get("/api/runs/{run_id}", response_model=WorkflowRunSchema)
def get_run(run_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return _own_run(db, run_id, user)


@app.get("/api/runs/{run_id}/events")
async def stream_run_events(run_id: str, request: Request, user: CurrentUser = Depends(get_current_user)):
    """Server-Sent Events: current snapshot first, then every update until the run ends."""
    def load() -> Optional[Dict[str, Any]]:
        with SessionLocal() as db:
            run = db.get(WorkflowRun, run_id)
            if not run or run.user_id != user.id:
                return None
            data = WorkflowRunSchema.model_validate(run).model_dump(mode="json")
            data["run_id"] = run.id
            return data

    queue: asyncio.Queue = asyncio.Queue()
    SUBSCRIBERS.setdefault(run_id, []).append(queue)  # subscribe before reading so nothing is missed

    def unsubscribe() -> None:
        subs = SUBSCRIBERS.get(run_id, [])
        if queue in subs:
            subs.remove(queue)
        if not subs:
            SUBSCRIBERS.pop(run_id, None)

    persisted = await asyncio.to_thread(load)
    if persisted is None:
        unsubscribe()
        raise HTTPException(status_code=404, detail="Run not found")
    first = LATEST_STATE.get(run_id) or persisted

    async def events():
        try:
            yield f"data: {json.dumps(first, default=str)}\n\n"
            if first.get("status") in TERMINAL_STATUSES:
                return
            while True:
                if await request.is_disconnected():
                    return
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    if run_id not in RUNNING_TASKS and run_id not in LATEST_STATE:
                        final = await asyncio.to_thread(load)
                        if final:
                            yield f"data: {json.dumps(final, default=str)}\n\n"
                        return
                    continue
                yield f"data: {json.dumps(data, default=str)}\n\n"
                if data.get("status") in TERMINAL_STATUSES:
                    return
        finally:
            unsubscribe()

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.post("/api/runs/{run_id}/cancel", response_model=WorkflowRunSchema)
async def cancel_run(run_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    run = _own_run(db, run_id, user)
    task = RUNNING_TASKS.get(run_id)
    if task and not task.done():
        task.cancel()
        await asyncio.wait([task], timeout=10)
    elif run.status not in TERMINAL_STATUSES:
        run.status, run.step, run.message, run.finished_at = "cancelled", "cancelled", "Cancelled by you.", _utcnow()
        db.commit()
    db.refresh(run)
    return run


@app.post("/api/runs/{run_id}/rerun", response_model=WorkflowRunSchema, status_code=201)
async def rerun(run_id: str, req: Optional[RerunRequest] = None, user: CurrentUser = Depends(get_current_user),
                db: Session = Depends(get_db)):
    old = _own_run(db, run_id, user)
    intent = (req.intent if req else None) or old.intent_override
    return await create_run(RunCreateRequest(prompt=old.prompt, mode=old.mode or "Balanced", country=old.country or "IN",
                                             intent=intent), user, db)


@app.delete("/api/runs/{run_id}", status_code=204)
async def delete_run(run_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    _own_run(db, run_id, user)
    task = RUNNING_TASKS.get(run_id)
    if task and not task.done():
        task.cancel()
        await asyncio.wait([task], timeout=10)
    db.execute(delete(WorkflowRun).where(WorkflowRun.id == run_id, WorkflowRun.user_id == user.id))
    db.commit()
    invalidate_user_suggestions(user.id)
    return Response(status_code=204)


# ---------------------------------------------------------------- datasets
def _own_dataset(db: Session, dataset_id: str, user: CurrentUser) -> Dataset:
    dataset = db.get(Dataset, dataset_id)
    if not dataset or dataset.user_id != user.id:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return dataset


def _records(db: Session, dataset_id: str) -> List[DataRecord]:
    return (db.query(DataRecord).filter(DataRecord.dataset_id == dataset_id)
            .order_by(DataRecord.score.desc().nullslast(), DataRecord.id.asc()).all())


@app.get("/api/datasets", response_model=List[DatasetSchema])
def list_datasets(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(Dataset).filter(Dataset.user_id == user.id).order_by(Dataset.created_at.desc()).all()


@app.get("/api/datasets/{dataset_id}")
def get_dataset(dataset_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    dataset = _own_dataset(db, dataset_id, user)
    data = DatasetSchema.model_validate(dataset).model_dump(mode="json")
    data["prompt"] = dataset.run.prompt if dataset.run else None
    data["records"] = [RecordSchema.model_validate(r).model_dump(mode="json") for r in _records(db, dataset_id)]
    return data


@app.delete("/api/datasets/{dataset_id}", status_code=204)
def delete_dataset(dataset_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    _own_dataset(db, dataset_id, user)
    db.execute(delete(Dataset).where(Dataset.id == dataset_id, Dataset.user_id == user.id))
    db.commit()
    return Response(status_code=204)


@app.get("/api/records/{record_id}", response_model=RecordDetailSchema)
def get_record(record_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    record = (db.query(DataRecord).join(Dataset, Dataset.id == DataRecord.dataset_id)
              .filter(DataRecord.id == record_id, Dataset.user_id == user.id).first())
    if not record:
        raise HTTPException(status_code=404, detail="Record not found")
    return record


def _csv_safe(value: Any) -> str:
    """Neutralise spreadsheet formula injection in scraped values."""
    text_value = "" if value is None else str(value)
    return "'" + text_value if text_value[:1] in ("=", "+", "-", "@", "\t", "\r") else text_value


def _export_name(dataset: Dataset, ext: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (dataset.name or "dataset").lower()).strip("-")[:50] or "dataset"
    return f"magpie-{slug}-{dataset.id[:8]}.{ext}"


def _column_value(record: DataRecord, key: str) -> Any:
    details = record.details or {}
    return (details.get("columns") or {}).get(key) or (details.get("fields") or {}).get(key) or details.get(key)


@app.get("/api/datasets/{dataset_id}/export/csv")
def export_csv(dataset_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    dataset = _own_dataset(db, dataset_id, user)
    columns = dataset.column_defs or []
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Name", "Organisation", "Location", *[c.get("label", c.get("key")) for c in columns], "Email",
                     "Phone", "Website", "Score", "Why it matched", "Source", "Source URL", "Also seen at",
                     "Collected at (UTC)"])
    for r in _records(db, dataset_id):
        d = r.details or {}
        writer.writerow([_csv_safe(v) for v in [
            r.title, r.company, r.location, *[_column_value(r, c.get("key")) for c in columns], r.email, r.phone,
            r.website, r.score, d.get("reason"), r.source, r.source_url, "; ".join(d.get("also_seen_at") or []),
            r.created_at.isoformat() if r.created_at else "",
        ]])
    return Response(content=output.getvalue().encode("utf-8-sig"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="{_export_name(dataset, "csv")}"'})


@app.get("/api/datasets/{dataset_id}/export/json")
def export_json(dataset_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    dataset = _own_dataset(db, dataset_id, user)
    payload = {
        "dataset": DatasetSchema.model_validate(dataset).model_dump(mode="json"),
        "prompt": dataset.run.prompt if dataset.run else None,
        "plan": dataset.run.spec if dataset.run else None,
        "records": [RecordDetailSchema.model_validate(r).model_dump(mode="json") for r in _records(db, dataset_id)],
    }
    return Response(content=json.dumps(payload, ensure_ascii=False, indent=2), media_type="application/json",
                    headers={"Content-Disposition": f'attachment; filename="{_export_name(dataset, "json")}"'})


# ---------------------------------------------------------------- leads & outreach
@app.get("/api/leads", response_model=List[LeadSchema])
def list_leads(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    return db.query(LeadOutreach).filter(LeadOutreach.user_id == user.id).order_by(LeadOutreach.created_at.desc()).all()


def _with_article(phrase: str) -> str:
    return f"{'an' if phrase[:1].lower() in 'aeiou' else 'a'} {phrase}"


def looking_for_text(dataset: Optional[Dataset], record_title: Optional[str]) -> Optional[str]:
    """What the user is looking for, phrased to follow "Krishna is looking for ..." -
    e.g. "a graphic designer in Noida" or "a React Developer opportunity"."""
    if dataset is None:
        return None
    spec = (dataset.run.spec if dataset.run else None) or {}
    if dataset.intent == "jobs":
        role = (record_title or spec.get("entity") or "").strip()
        return f"{_with_article(role)} opportunity" if role else None
    entity = str(spec.get("entity") or "").strip()
    if not entity or entity.lower() == "result":
        return (dataset.label or "").strip() or None
    place = dataset.place or spec.get("place") or {}
    where = place.get("city") or place.get("region") or place.get("country")
    text = _with_article(entity)
    if where and place.get("scope") in ("city", "region", "country") and where.lower() not in entity.lower():
        text += f" in {where}"
    return text


@app.post("/api/leads/from-records")
def leads_from_records(req: LeadsFromRecordsRequest, user: CurrentUser = Depends(get_current_user),
                       db: Session = Depends(get_db)):
    rows = (db.query(DataRecord, Dataset).join(Dataset, Dataset.id == DataRecord.dataset_id)
            .filter(DataRecord.id.in_(req.record_ids), Dataset.user_id == user.id).all())
    existing = {rid for (rid,) in db.query(LeadOutreach.record_id)
                .filter(LeadOutreach.user_id == user.id, LeadOutreach.record_id.in_(req.record_ids)).all()}
    created: List[LeadOutreach] = []
    for record, dataset in rows:
        if record.id in existing:
            continue
        details = record.details or {}
        columns = details.get("columns") or {}
        if dataset.intent == "jobs":
            contact = f"{record.company} hiring team" if record.company else (record.title or "Hiring team")
            role = record.title
        else:
            contact = record.title or record.company or "Contact"
            role = columns.get("role") or details.get("role") or details.get("category") or dataset.label
        lead = LeadOutreach(user_id=user.id, record_id=record.id, dataset_id=dataset.id,
                            contact_name=str(contact)[:300], email=record.email, phone=record.phone,
                            company=record.company or (record.title if dataset.intent != "jobs" else None),
                            role=str(role)[:300] if role else None, website=record.website,
                            source_url=record.source_url, status="queued",
                            looking_for=looking_for_text(dataset, record.title))
        db.add(lead)
        created.append(lead)
    db.commit()
    for lead in created:
        db.refresh(lead)
    return {"added": len(created), "already_in_leads": len(existing), "with_email": sum(1 for l in created if l.email),
            "leads": [LeadSchema.model_validate(l).model_dump(mode="json") for l in created]}


def _own_lead(db: Session, lead_id: str, user: CurrentUser) -> LeadOutreach:
    lead = db.get(LeadOutreach, lead_id)
    if not lead or lead.user_id != user.id:
        raise HTTPException(status_code=404, detail="Lead not found")
    return lead


@app.patch("/api/leads/{lead_id}", response_model=LeadSchema)
def update_lead(lead_id: str, changes: LeadUpdateRequest, user: CurrentUser = Depends(get_current_user),
                db: Session = Depends(get_db)):
    lead = _own_lead(db, lead_id, user)
    for field, value in changes.model_dump(exclude_unset=True).items():
        setattr(lead, field, value)
    db.commit()
    db.refresh(lead)
    return lead


@app.delete("/api/leads/{lead_id}", status_code=204)
def delete_lead(lead_id: str, user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    _own_lead(db, lead_id, user)
    db.execute(delete(LeadOutreach).where(LeadOutreach.id == lead_id, LeadOutreach.user_id == user.id))
    db.commit()
    return Response(status_code=204)


@app.post("/api/leads/{lead_id}/send", response_model=LeadSchema)
async def send_lead(lead_id: str, req: LeadSendRequest, user: CurrentUser = Depends(get_current_user)):
    def load() -> tuple:
        with SessionLocal() as db:
            lead = _own_lead(db, lead_id, user)
            looking_for = lead.looking_for
            if not looking_for and lead.dataset_id:  # leads created before this field existed
                record = db.get(DataRecord, lead.record_id) if lead.record_id else None
                looking_for = looking_for_text(db.get(Dataset, lead.dataset_id), record.title if record else lead.role)
            return lead, looking_for

    lead, looking_for = await asyncio.to_thread(load)
    if lead.status == "sent":
        raise HTTPException(status_code=409, detail="This lead was already e-mailed.")
    if not lead.email:
        raise HTTPException(status_code=400, detail="This lead has no e-mail address. Add one first.")
    values = {"name": lead.contact_name, "company": lead.company, "role": lead.role, "sender": user.name,
              "sender_email": user.email, "looking_for": looking_for}
    subject = render_template(req.template_subject, **values)
    body = render_template(req.template_body, **values)
    status, message_id, error = await deliver(lead.email, subject, with_footer(body, user.name), user.email)

    def save() -> LeadOutreach:
        with SessionLocal() as db:
            row = _own_lead(db, lead_id, user)
            row.template_subject, row.template_body = subject, body
            row.status, row.message_id, row.last_error = status, message_id, error
            if status in ("sent", "simulated"):
                row.sent_at = _utcnow()
            db.commit()
            db.refresh(row)
            return row

    return await asyncio.to_thread(save)


@app.post("/api/leads/draft")
async def draft_template(req: DraftRequest, user: CurrentUser = Depends(get_current_user)):
    def context() -> str:
        if not req.dataset_id:
            return ""
        with SessionLocal() as db:
            dataset = db.get(Dataset, req.dataset_id)
            if not dataset or dataset.user_id != user.id:
                return ""
            return f"The contacts were collected for: {dataset.label or dataset.name}."

    about = await asyncio.to_thread(context)
    goal = req.goal or "connect with them"
    data = await chat_json(
        "You write short, warm, honest outreach e-mails for Magpie, a platform that helps people find the right "
        "professionals and businesses. The e-mail is sent BY Team Magpie TO someone we found, introducing a Magpie "
        "user who wants to connect. Return JSON {\"subject\": string, \"body\": string}. The body must start with "
        "'Hi {name},', say 'This is Team Magpie', explain that {sender} is looking for {looking_for} and what they "
        "want, invite them to reach {sender} at {sender_email} or simply reply, and end with 'Best regards,\\nTeam "
        "Magpie'. Keep these placeholders exactly as written: {name}, {sender}, {sender_email}, {looking_for}. "
        "Max 110 words, no fake claims, no other signature.",
        f"What the user wants: {goal}. {about}", max_tokens=600, temperature=0.4, timeout=40)
    if isinstance(data, dict) and data.get("subject") and data.get("body"):
        return {"subject": str(data["subject"])[:300], "body": str(data["body"])[:5000], "ai": True}
    return {"subject": DEFAULT_SUBJECT, "body": DEFAULT_BODY, "ai": False}


@app.get("/api/me/summary")
def my_summary(user: CurrentUser = Depends(get_current_user), db: Session = Depends(get_db)):
    runs = db.query(func.count(WorkflowRun.id)).filter(WorkflowRun.user_id == user.id).scalar() or 0
    datasets = db.query(func.count(Dataset.id)).filter(Dataset.user_id == user.id).scalar() or 0
    leads = db.query(func.count(LeadOutreach.id)).filter(LeadOutreach.user_id == user.id).scalar() or 0
    return {"runs": runs, "datasets": datasets, "leads": leads}
