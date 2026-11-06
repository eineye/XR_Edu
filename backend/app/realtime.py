"""관리자 화면용 WebSocket 브로드캐스트."""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket

from .timeutil import now_iso

log = logging.getLogger("mr_edu.realtime")


class ConnectionManager:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def _broadcast(self, message: str) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_text(message)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

    def publish(self, event_type: str, data: dict | None = None) -> None:
        """동기 코드(스레드풀)와 비동기 코드 어디서든 호출 가능."""
        if self.loop is None or not self.clients:
            return
        message = json.dumps({"type": event_type, "data": data or {}, "server_time": now_iso()}, ensure_ascii=False)
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is self.loop:
            self.loop.create_task(self._broadcast(message))
        else:
            asyncio.run_coroutine_threadsafe(self._broadcast(message), self.loop)


manager = ConnectionManager()
