"""MR EDU MOBILE 2.0 관리자 서버 진입점.

실행: (backend 폴더에서) python -m app.main  또는  uvicorn app.main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta

import jwt
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from . import backup as bk
from .config import config
from .db import db_session, get_settings, init_db
from .realtime import manager
from .routers import auth, contents, dashboard, devices, logs, reports, results, sessions, settings, sync, users
from .security import decode_token
from .status import evaluate_device
from .timeutil import local_tz, now_iso, now_utc

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("mr_edu")


def _log_api_error(method: str, path: str, status: int, message: str, client: str | None) -> None:
    try:
        with db_session() as conn:
            conn.execute(
                "INSERT INTO api_error_logs(method, path, status_code, message, client, created_at) VALUES (?,?,?,?,?,?)",
                (method, path, status, message[:1000], client, now_iso()))
            conn.commit()
    except Exception:  # noqa: BLE001
        log.exception("오류 로그 기록 실패")


def monitor_devices_once(state: dict[str, str]) -> None:
    """heartbeat 미수신으로 오프라인이 된 장비를 감지해 알린다."""
    with db_session() as conn:
        s = get_settings(conn)
        for row in conn.execute("SELECT * FROM devices WHERE active=1").fetchall():
            d = evaluate_device(dict(row), s)
            prev = state.get(d["device_id"])
            state[d["device_id"]] = d["connection_status"]
            if row["connection_status"] != d["connection_status"]:
                conn.execute("UPDATE devices SET connection_status=? WHERE device_id=?",
                             (d["connection_status"], d["device_id"]))
            if prev == "online" and d["connection_status"] == "offline":
                manager.publish("device.offline", {"device_id": d["device_id"], "last_seen_at": d["last_seen_at"]})
        conn.commit()


def maintenance_once() -> None:
    with db_session() as conn:
        s = get_settings(conn)
        cutoff = (now_utc() - timedelta(days=s["log_retention_days"])).isoformat()
        for table, col in (("heartbeat_logs", "received_at"), ("api_error_logs", "created_at"),
                           ("sync_logs", "created_at"), ("audit_logs", "created_at")):
            conn.execute(f"DELETE FROM {table} WHERE {col} < ?", (cutoff,))
        conn.commit()
        if s["auto_backup_enabled"] and datetime.now(local_tz()).hour >= s["auto_backup_hour"] \
                and not bk.has_auto_backup_today(conn):
            r = bk.create_backup(conn, "auto")
            bk.prune_auto_backups(conn, s["backup_keep_count"])
            log.info("자동 백업 완료: %s", r["file"])


async def _loop(fn, interval: float, *args) -> None:
    while True:
        try:
            await asyncio.to_thread(fn, *args)
        except Exception:  # noqa: BLE001
            log.exception("백그라운드 작업 오류: %s", fn.__name__)
        await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    manager.loop = asyncio.get_running_loop()
    tasks = [asyncio.create_task(_loop(monitor_devices_once, 5, {})),
             asyncio.create_task(_loop(maintenance_once, 600))]
    log.info("MR EDU MOBILE 2.0 서버 시작 (DB: %s)", config.db_file)
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="MR EDU MOBILE 2.0 관리자 API", version=__version__, lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=config.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])


@app.exception_handler(StarletteHTTPException)
async def http_exc(request: Request, exc: StarletteHTTPException):
    if exc.status_code >= 400 and exc.status_code != 401 and request.url.path.startswith("/api"):
        msg = exc.detail if isinstance(exc.detail, str) else str(exc.detail.get("message", exc.detail)) \
            if isinstance(exc.detail, dict) else str(exc.detail)
        await asyncio.to_thread(_log_api_error, request.method, request.url.path, exc.status_code, msg,
                                request.client.host if request.client else None)
    return JSONResponse({"detail": exc.detail}, status_code=exc.status_code, headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def validation_exc(request: Request, exc: RequestValidationError):
    errors = [{"loc": [str(x) for x in e["loc"]], "msg": e["msg"]} for e in exc.errors()]
    summary = "; ".join(f"{'.'.join(e['loc'][1:]) or e['loc'][0]}: {e['msg']}" for e in errors)
    await asyncio.to_thread(_log_api_error, request.method, request.url.path, 422, summary,
                            request.client.host if request.client else None)
    return JSONResponse({"detail": f"입력값 오류 — {summary}", "errors": errors}, status_code=422)


@app.exception_handler(Exception)
async def unhandled_exc(request: Request, exc: Exception):
    log.exception("처리되지 않은 오류")
    await asyncio.to_thread(_log_api_error, request.method, request.url.path, 500, repr(exc),
                            request.client.host if request.client else None)
    return JSONResponse({"detail": "서버 내부 오류가 발생했습니다"}, status_code=500)


@app.get("/health", tags=["system"])
def health():
    """HMD·관리자 화면 공용 서버 상태 확인 (인증 불필요)."""
    try:
        with db_session() as conn:
            conn.execute("SELECT 1").fetchone()
        db_ok = True
    except Exception:  # noqa: BLE001
        db_ok = False
    return JSONResponse({"status": "ok" if db_ok else "degraded", "db": "ok" if db_ok else "error",
                         "version": __version__, "server_time": now_iso()}, status_code=200 if db_ok else 503)


for r in (auth, users, devices, sessions, sync, results, contents, dashboard, reports, settings, logs):
    app.include_router(r.router)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    """관리자 화면 실시간 갱신. ?token=<JWT> 필요. (HMD는 WebSocket 을 사용하지 않아도 된다)"""
    token = ws.query_params.get("token")
    try:
        decode_token(token or "")
    except jwt.PyJWTError:
        await ws.close(code=4401)
        return
    await manager.connect(ws)
    try:
        await ws.send_json({"type": "hello", "data": {}, "server_time": now_iso()})
        while True:
            msg = await ws.receive_text()
            if msg == "ping":
                await ws.send_json({"type": "pong", "data": {}, "server_time": now_iso()})
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws)


# 빌드된 관리자 화면(frontend/dist)을 같은 포트로 제공 → 설치 PC에서 단일 서버로 운영
_dist = config.frontend_dir
if (_dist / "index.html").exists():
    if (_dist / "assets").exists():
        app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith(("api/", "ws", "health", "docs", "openapi.json")):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        f = (_dist / full_path).resolve()
        if full_path and f.is_file() and _dist.resolve() in f.parents:
            return FileResponse(f)
        return FileResponse(_dist / "index.html")


def run() -> None:
    import uvicorn

    uvicorn.run("app.main:app", host=config.host, port=config.port, log_level="info")


if __name__ == "__main__":
    run()
