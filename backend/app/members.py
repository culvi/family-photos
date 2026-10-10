"""Signed-in family members: display names, faces, and who may see the Usage page."""

from __future__ import annotations

from typing import Iterable, Optional

from .config import settings


def parse_members(entries: Iterable[str]) -> dict[str, str]:
    """["nadia@x.com=Nadia", ...] -> {"nadia@x.com": "Nadia"} (emails lowercased)."""
    members: dict[str, str] = {}
    for entry in entries or []:
        email, sep, name = str(entry).partition("=")
        email = email.strip().lower()
        if sep and "@" in email and name.strip():
            members[email] = name.strip()
    return members


def display_name(email: str, members: Optional[dict[str, str]] = None) -> str:
    members = parse_members(settings.members) if members is None else members
    if email in members:
        return members[email]
    local = email.split("@", 1)[0]
    return local[:1].upper() + local[1:]


def is_admin(email: Optional[str]) -> bool:
    if not email:
        return False
    return email.lower() in {a.strip().lower() for a in settings.admin_emails if a.strip()}


def person_for_name(name: str, people: list[dict]) -> Optional[str]:
    """The Immich person id for a display name: an exact name match, else a unique
    person whose first name matches ("Nadia" -> "Nadia Neville")."""
    wanted = name.strip().lower()
    if not wanted:
        return None
    named = [p for p in people if isinstance(p, dict) and p.get("id") and (p.get("name") or "").strip()]
    exact = [p for p in named if p["name"].strip().lower() == wanted]
    if exact:
        return exact[0]["id"]
    first = wanted.split()[0]
    by_first = [p for p in named if p["name"].strip().lower().split()[0] == first]
    return by_first[0]["id"] if len(by_first) == 1 else None
