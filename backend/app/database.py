import logging

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import declarative_base, sessionmaker

from app.config import settings

logger = logging.getLogger("magpie.db")


class DatabaseConfigError(RuntimeError):
    pass


def _normalize_db_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        raise DatabaseConfigError(
            "DATABASE_URL is not set. Magpie stores everything in Neon Postgres: add your Neon "
            "connection string to backend/.env (or to the Render environment)."
        )
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if not url.startswith(("postgresql://", "postgresql+psycopg2://")):
        raise DatabaseConfigError("DATABASE_URL must be a PostgreSQL (Neon) connection string.")
    return url


engine = create_engine(
    _normalize_db_url(settings.DATABASE_URL),
    pool_pre_ping=True,  # Neon closes idle connections
    pool_recycle=300,
    pool_size=5,
    max_overflow=10,
    connect_args={"connect_timeout": 15},
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    """Create tables, then add columns and indexes introduced after a table was first created."""
    import app.models  # noqa: F401  (register models)

    Base.metadata.create_all(bind=engine)
    inspector = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            existing = {col["name"] for col in inspector.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing or column.primary_key:
                    continue
                col_type = column.type.compile(dialect=engine.dialect)
                logger.info("Adding column %s.%s", table.name, column.name)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN IF NOT EXISTS "{column.name}" {col_type}'))
        for table in Base.metadata.sorted_tables:
            for index in table.indexes:
                index.create(bind=conn, checkfirst=True)
