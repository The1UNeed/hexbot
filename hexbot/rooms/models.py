"""Typed room records used at module boundaries."""

from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class Room:
    id: str
    name: str
    owner_id: str
    main_bot: str | None
    approval_mode: str | None
    limits: dict[str, Any]
    created_at: float
    updated_at: float
    last_activity_at: float
    archived_at: float | None

    def dict(self) -> dict:
        return asdict(self)


@dataclass(frozen=True)
class RoomEvent:
    room_id: str
    seq: int
    kind: str
    actor_kind: str | None
    actor_id: str | None
    payload: dict[str, Any]
    created_at: float

    def dict(self) -> dict:
        return asdict(self)
