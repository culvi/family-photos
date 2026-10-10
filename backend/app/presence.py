"""Who's on the site right now, and what they're looking at (in memory)."""

from __future__ import annotations

from typing import Optional

ACTIVE_SECONDS = 45  # browsers check in every ~20 s; two missed beats and you're gone
VISIT_GAP_SECONDS = 30 * 60  # back after half an hour away counts as a new visit
WHERE = ("grid", "photo", "map", "people")


class PresenceBoard:
    def __init__(self) -> None:
        self._here: dict[str, dict] = {}  # email -> {assetId, where, seen, since}
        self._last: dict[str, float] = {}  # email -> last check-in (survives leaving)

    def beat(
        self,
        email: str,
        asset_id: Optional[str],
        where: str,
        now: float,
        last_logged: Optional[float] = None,
    ) -> list[tuple[str, Optional[str]]]:
        """Record a check-in; returns the usage events it amounts to:
        ("visit", None) when someone arrives, ("photo", id) when they open a new photo."""
        events: list[tuple[str, Optional[str]]] = []
        last = self._last.get(email, last_logged)
        if last is None or now - last > VISIT_GAP_SECONDS:
            events.append(("visit", None))

        previous = self._here.get(email)
        if previous and now - previous["seen"] > ACTIVE_SECONDS:
            previous = None
        if asset_id and (not previous or previous.get("assetId") != asset_id):
            events.append(("photo", asset_id))

        self._here[email] = {
            "assetId": asset_id,
            "where": where if where in WHERE else "grid",
            "seen": now,
            "since": previous["since"] if previous else now,
        }
        self._last[email] = now
        return events

    def knows(self, email: str) -> bool:
        """Checked in since the server started (else ask the usage log when they last were)."""
        return email in self._last

    def leave(self, email: str) -> None:
        self._here.pop(email, None)

    def active(self, now: float, exclude: Optional[str] = None) -> list[dict]:
        for email in [e for e, p in self._here.items() if now - p["seen"] > ACTIVE_SECONDS]:
            del self._here[email]
        return [
            {"email": email, **entry}
            for email, entry in sorted(self._here.items(), key=lambda item: item[1]["since"])
            if email != exclude
        ]
