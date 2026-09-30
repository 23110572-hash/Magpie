import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Column, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import relationship

from app.database import Base


def gen_uuid() -> str:
    return str(uuid.uuid4())


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=gen_uuid)
    email = Column(String(254), nullable=False, unique=True, index=True)
    name = Column(String(120), nullable=False)
    password_hash = Column(Text, nullable=False)
    token_version = Column(Integer, nullable=False, default=0)  # bump to sign out everywhere
    created_at = Column(DateTime(timezone=True), default=utc_now)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    last_login_at = Column(DateTime(timezone=True), nullable=True)


class WorkflowRun(Base):
    __tablename__ = "workflow_runs"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    prompt = Column(Text, nullable=False)
    mode = Column(String(16), default="Balanced")
    country = Column(String(8), default="IN")
    intent_override = Column(String(32), nullable=True)
    status = Column(String(16), default="pending")  # running, completed, failed, cancelled
    step = Column(String(32), default="queued")
    progress = Column(Float, default=0.0)
    eta_seconds = Column(Integer, default=0)
    message = Column(Text, nullable=True)
    spec = Column(JSON, default=dict)
    stats = Column(JSON, default=dict)
    created_at = Column(DateTime(timezone=True), default=utc_now, index=True)
    updated_at = Column(DateTime(timezone=True), default=utc_now, onupdate=utc_now)
    finished_at = Column(DateTime(timezone=True), nullable=True)

    datasets = relationship("Dataset", back_populates="run", cascade="all, delete-orphan", passive_deletes=True)


class Dataset(Base):
    __tablename__ = "datasets"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    workflow_run_id = Column(String, ForeignKey("workflow_runs.id", ondelete="CASCADE"), nullable=True, index=True)
    name = Column(String(300), nullable=False)
    category = Column(String(32), default="other")
    intent = Column(String(32), nullable=True)
    label = Column(Text, nullable=True)
    country = Column(String(8), nullable=True)
    place = Column(JSON, default=dict)
    column_defs = Column(JSON, default=list)
    coverage = Column(JSON, default=dict)
    row_count = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), default=utc_now, index=True)

    run = relationship("WorkflowRun", back_populates="datasets")
    records = relationship("DataRecord", back_populates="dataset", cascade="all, delete-orphan", passive_deletes=True)


class DataRecord(Base):
    __tablename__ = "data_records"

    id = Column(String, primary_key=True, default=gen_uuid)
    dataset_id = Column(String, ForeignKey("datasets.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(Text, nullable=True)
    company = Column(Text, nullable=True)
    location = Column(Text, nullable=True)
    email = Column(String(254), nullable=True)
    phone = Column(String(64), nullable=True)
    website = Column(Text, nullable=True)
    score = Column(Float, nullable=True)
    source = Column(String(120), nullable=True)
    source_url = Column(Text, nullable=True)
    details = Column(JSON, default=dict)
    raw_snapshot = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)

    dataset = relationship("Dataset", back_populates="records")


class LeadOutreach(Base):
    __tablename__ = "lead_outreach"

    id = Column(String, primary_key=True, default=gen_uuid)
    user_id = Column(String, ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    record_id = Column(String, nullable=True, index=True)
    dataset_id = Column(String, nullable=True)
    contact_name = Column(String(300), nullable=False)
    email = Column(String(254), nullable=True)
    phone = Column(String(64), nullable=True)
    company = Column(Text, nullable=True)
    role = Column(Text, nullable=True)
    website = Column(Text, nullable=True)
    source_url = Column(Text, nullable=True)
    status = Column(String(16), default="queued")  # queued, sent, simulated, failed
    template_subject = Column(Text, nullable=True)
    template_body = Column(Text, nullable=True)
    last_error = Column(Text, nullable=True)
    message_id = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), default=utc_now)
    sent_at = Column(DateTime(timezone=True), nullable=True)
