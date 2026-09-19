from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Protocol, TypeAlias

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

FormValue: TypeAlias = str | int | float | bool | None
FormData: TypeAlias = dict[str, FormValue]


@dataclass(frozen=True)
class FormState:
    data: FormData
    revision: int
    updated_at: str | None


class FormStore(Protocol):
    async def load(self, form_id: str) -> FormState: ...

    async def patch(self, form_id: str, changes: FormData) -> FormState: ...


class InMemoryFormStore:
    def __init__(self) -> None:
        self._forms: dict[str, FormState] = {}

    async def load(self, form_id: str) -> FormState:
        return self._forms.get(form_id, FormState(data={}, revision=0, updated_at=None))

    async def patch(self, form_id: str, changes: FormData) -> FormState:
        current = await self.load(form_id)
        state = FormState(
            data={**current.data, **changes},
            revision=current.revision + 1,
            updated_at=datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        )
        self._forms[form_id] = state
        return state


class PatchRequest(BaseModel):
    changes: dict[str, Any]


class FormRoom:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.presence: dict[WebSocket, dict[str, Any]] = {}


class FormHub:
    def __init__(self) -> None:
        self._rooms: dict[str, FormRoom] = {}

    def connect(self, form_id: str, websocket: WebSocket) -> FormRoom:
        room = self._rooms.setdefault(form_id, FormRoom())
        room.clients.add(websocket)
        return room

    def disconnect(self, form_id: str, websocket: WebSocket) -> None:
        room = self._rooms.get(form_id)
        if room is None:
            return
        room.clients.discard(websocket)
        room.presence.pop(websocket, None)
        if not room.clients:
            self._rooms.pop(form_id, None)

    async def broadcast(self, form_id: str, message: dict[str, Any], exclude: WebSocket | None = None) -> None:
        room = self._rooms.get(form_id)
        if room is None:
            return
        for client in tuple(room.clients):
            if client is not exclude:
                await client.send_json(message)

    async def broadcast_presence(self, form_id: str) -> None:
        room = self._rooms.get(form_id)
        if room is not None:
            await self.broadcast(form_id, {"type": "presence-state", "documentId": form_id, "presence": list(room.presence.values())})


def response_body(form_id: str, state: FormState) -> dict[str, Any]:
    return {
        "documentId": form_id,
        "data": state.data,
        "revision": state.revision,
        "updatedAt": state.updated_at,
    }


def is_form_value(value: Any) -> bool:
    return value is None or (isinstance(value, (str, int, float, bool)) and not isinstance(value, (list, dict)))


def create_app(store: FormStore | None = None, allowed_origins: list[str] | None = None) -> FastAPI:
    form_store = store or InMemoryFormStore()
    hub = FormHub()
    app = FastAPI(title="Formsocket Python")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins or [],
        allow_credentials=False,
        allow_methods=["GET", "PATCH", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/api/documents/{form_id}")
    async def load_form(form_id: str) -> dict[str, Any]:
        return response_body(form_id, await form_store.load(form_id))

    @app.patch("/api/documents/{form_id}")
    async def patch_form(form_id: str, request: PatchRequest) -> dict[str, Any]:
        if not request.changes or any(not field or not is_form_value(value) for field, value in request.changes.items()):
            raise HTTPException(status_code=400, detail="changes must contain supported field values")
        state = await form_store.patch(form_id, request.changes)
        message = {"type": "persisted", **response_body(form_id, state)}
        await hub.broadcast(form_id, message)
        return message

    @app.websocket("/form/{form_id}")
    async def collaborate(websocket: WebSocket, form_id: str) -> None:
        await websocket.accept()
        room = hub.connect(form_id, websocket)
        await websocket.send_json({"type": "ready", "documentId": form_id})
        await websocket.send_json({"type": "presence-state", "documentId": form_id, "presence": list(room.presence.values())})

        try:
            while True:
                payload = await websocket.receive_json()
                if payload.get("type") == "update" and isinstance(payload.get("field"), str) and payload["field"] and is_form_value(payload.get("value")):
                    await hub.broadcast(form_id, {"type": "update", "documentId": form_id, "field": payload["field"], "value": payload.get("value")}, exclude=websocket)
                elif payload.get("type") == "presence":
                    if payload.get("field") is None:
                        room.presence.pop(websocket, None)
                    elif isinstance(payload.get("field"), str) and payload["field"] and isinstance(payload.get("user"), dict):
                        room.presence[websocket] = {
                            "field": payload["field"],
                            "user": payload["user"],
                            "selectionStart": payload.get("selectionStart") if isinstance(payload.get("selectionStart"), int) else None,
                            "selectionEnd": payload.get("selectionEnd") if isinstance(payload.get("selectionEnd"), int) else None,
                        }
                    await hub.broadcast_presence(form_id)
        except WebSocketDisconnect:
            hub.disconnect(form_id, websocket)
            await hub.broadcast_presence(form_id)

    return app


app = create_app()