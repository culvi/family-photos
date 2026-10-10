"""Split Immich's people list into named people and the most-seen unnamed faces.

Immich returns people ordered named-first, then by face count (most photos first), and
only includes an unnamed person once they appear in at least ``minimumFaces`` photos
(default 3). So the first unnamed entries are the faces that recur most: the "More faces"
section on the People page.
"""

from __future__ import annotations

from typing import Any

UNNAMED_LIMIT = 36  # a full 3-column grid on phones


def split_people(
    people: list[dict[str, Any]],
    allowed: set[str] | None = None,
    unnamed_limit: int = UNNAMED_LIMIT,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (named sorted by name, top unnamed in Immich's most-seen-first order).

    ``allowed`` restricts both lists to an album-scoped session's people. Hidden people
    never appear in the unnamed list (scoped sessions fetch with hidden included).
    """
    if allowed is not None:
        people = [p for p in people if p.get("id") in allowed]

    named = [p for p in people if (p.get("name") or "").strip()]
    named.sort(key=lambda p: p["name"].strip().lower())

    unnamed = [
        p
        for p in people
        if p.get("id") and not (p.get("name") or "").strip() and not p.get("isHidden")
    ][:unnamed_limit]

    return named, unnamed
