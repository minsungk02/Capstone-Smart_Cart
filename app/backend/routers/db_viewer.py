"""Read-only DB viewer pages for quick table inspection in browser."""

from __future__ import annotations

import html
import os
import secrets
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import HTMLResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.database import get_db

router = APIRouter(prefix="/api/db-viewer", tags=["db-viewer"])
security = HTTPBasic()


def _require_basic_auth(
    credentials: Annotated[HTTPBasicCredentials, Depends(security)],
) -> None:
    expected_user = os.getenv("DB_VIEWER_USER", "").strip()
    expected_password = os.getenv("DB_VIEWER_PASSWORD", "").strip()

    if not expected_user or not expected_password:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="DB viewer credentials are not configured",
        )

    user_ok = secrets.compare_digest(credentials.username, expected_user)
    password_ok = secrets.compare_digest(credentials.password, expected_password)
    if not (user_ok and password_ok):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid DB viewer credentials",
            headers={"WWW-Authenticate": "Basic"},
        )


def _html_page(title: str, body: str) -> str:
    return f"""<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{html.escape(title)}</title>
  <style>
    body {{
      margin: 0;
      padding: 24px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f5f7fb;
      color: #111827;
    }}
    .wrap {{
      max-width: 1200px;
      margin: 0 auto;
    }}
    .card {{
      background: #fff;
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.03);
    }}
    table {{
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
      overflow-x: auto;
    }}
    th, td {{
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
      padding: 8px 10px;
      vertical-align: top;
      max-width: 280px;
      word-break: break-word;
    }}
    th {{
      position: sticky;
      top: 0;
      background: #f9fafb;
    }}
    a {{
      color: #2563eb;
      text-decoration: none;
    }}
    .muted {{
      color: #6b7280;
      font-size: 13px;
    }}
    .toolbar {{
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }}
    .btn {{
      display: inline-block;
      padding: 6px 10px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      color: #111827;
    }}
  </style>
</head>
<body>
  <div class="wrap">
    {body}
  </div>
</body>
</html>"""


@router.get("", response_class=HTMLResponse)
def db_viewer_home(
    _auth: None = Depends(_require_basic_auth),
    db: Session = Depends(get_db),
):
    try:
        current_db = db.execute(text("SELECT DATABASE() AS db_name")).mappings().first()
        db_name = str(current_db["db_name"]) if current_db and current_db["db_name"] else "unknown"
        rows = db.execute(
            text(
                """
                SELECT table_name AS tname, COALESCE(table_rows, 0) AS trows
                FROM information_schema.tables
                WHERE table_schema = DATABASE()
                ORDER BY table_name
                """
            )
        ).mappings().all()
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    table_rows = []
    for row in rows:
        tname = str(row["tname"])
        rcnt = int(row["trows"] or 0)
        table_rows.append(
            f"<tr><td><a href='/api/db-viewer/table/{html.escape(tname)}'>{html.escape(tname)}</a></td><td>{rcnt}</td></tr>"
        )
    if not table_rows:
        table_rows.append("<tr><td colspan='2'>No tables found.</td></tr>")

    body = f"""
    <div class="card">
      <h2 style="margin:0 0 8px 0;">DB Viewer</h2>
      <div class="muted">Database: <strong>{html.escape(db_name)}</strong></div>
    </div>
    <div class="card">
      <h3 style="margin-top:0;">Tables</h3>
      <table>
        <thead><tr><th>table_name</th><th>approx_rows</th></tr></thead>
        <tbody>{''.join(table_rows)}</tbody>
      </table>
    </div>
    """
    return HTMLResponse(_html_page("DB Viewer", body))


@router.get("/table/{table_name}", response_class=HTMLResponse)
def db_viewer_table(
    table_name: str,
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
    _auth: None = Depends(_require_basic_auth),
    db: Session = Depends(get_db),
):
    try:
        allowed = {
            str(r["tname"])
            for r in db.execute(
                text(
                    """
                    SELECT table_name AS tname
                    FROM information_schema.tables
                    WHERE table_schema = DATABASE()
                    """
                )
            ).mappings()
        }
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    if table_name not in allowed:
        raise HTTPException(status_code=404, detail="Table not found")

    safe_name = table_name.replace("`", "``")
    try:
        col_rows = db.execute(
            text(
                """
                SELECT column_name AS cname
                FROM information_schema.columns
                WHERE table_schema = DATABASE() AND table_name = :table_name
                ORDER BY ordinal_position
                """
            ),
            {"table_name": table_name},
        ).mappings().all()
        columns = [str(r["cname"]) for r in col_rows]

        total_rows = db.execute(
            text(f"SELECT COUNT(*) AS cnt FROM `{safe_name}`")
        ).mappings().first()
        total_count = int(total_rows["cnt"]) if total_rows else 0

        data_rows = db.execute(
            text(f"SELECT * FROM `{safe_name}` LIMIT :limit OFFSET :offset"),
            {"limit": limit, "offset": offset},
        ).mappings().all()
    except SQLAlchemyError as exc:
        raise HTTPException(status_code=500, detail=f"DB error: {exc}") from exc

    header_html = "".join(f"<th>{html.escape(col)}</th>" for col in columns)
    data_html_rows: list[str] = []
    for row in data_rows:
        cols = []
        for col in columns:
            value = row.get(col)
            cols.append(f"<td>{html.escape('' if value is None else str(value))}</td>")
        data_html_rows.append(f"<tr>{''.join(cols)}</tr>")
    if not data_html_rows:
        data_html_rows.append(f"<tr><td colspan='{max(len(columns), 1)}'>No rows.</td></tr>")

    next_offset = offset + limit
    prev_offset = max(offset - limit, 0)
    prev_link = f"/api/db-viewer/table/{html.escape(table_name)}?limit={limit}&offset={prev_offset}"
    next_link = f"/api/db-viewer/table/{html.escape(table_name)}?limit={limit}&offset={next_offset}"

    body = f"""
    <div class="card">
      <div class="toolbar">
        <a class="btn" href="/api/db-viewer">← Tables</a>
        <a class="btn" href="{prev_link}">Prev</a>
        <a class="btn" href="{next_link}">Next</a>
      </div>
      <h3 style="margin: 8px 0 6px 0;">{html.escape(table_name)}</h3>
      <div class="muted">Rows: {total_count} · limit={limit} · offset={offset}</div>
    </div>
    <div class="card" style="overflow:auto;">
      <table>
        <thead><tr>{header_html}</tr></thead>
        <tbody>{''.join(data_html_rows)}</tbody>
      </table>
    </div>
    """
    return HTMLResponse(_html_page(f"DB Viewer - {table_name}", body))
