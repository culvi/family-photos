"""Split Immich's people list into named people and the most-seen unnamed faces.

Immich returns people ordered named-first, then by face count (most photos first), and
only includes an unnamed person once they appear in at least ``minimumFaces`` photos
(default 3). The list carries no counts, but because it's sorted, the cutoff for "in at
least N photos" can be found with a binary search over per-person photo counts: about
log2(n) lookups instead of one per person.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

FALLBACK_UNNAMED = 36  # when photo counts aren't available: a full 3-column grid on phones
MAX_UNNAMED = 500  # safety cap on the "More faces" section


def split_people(
    people: list[dict[str, Any]],
    allowed: set[str] | None = None,
    unnamed_limit: int | None = FALLBACK_UNNAMED,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Return (named sorted by name, unnamed in Immich's most-seen-first order).

    ``allowed`` restricts both lists to an album-scoped session's people. Hidden people
    never appear in the unnamed list (scoped sessions fetch with hidden included).
    ``unnamed_limit=None`` returns every unnamed person.
    """
    if allowed is not None:
        people = [p for p in people if p.get("id") in allowed]

    named = [p for p in people if (p.get("name") or "").strip()]
    named.sort(key=lambda p: p["name"].strip().lower())

    unnamed = [
        p
        for p in people
        if p.get("id") and not (p.get("name") or "").strip() and not p.get("isHidden")
    ]
    if unnamed_limit is not None:
        unnamed = unnamed[:unnamed_limit]

    return named, unnamed


async def unnamed_with_min_photos(
    unnamed: list[dict[str, Any]],
    min_photos: int,
    photo_count: Callable[[str], Awaitable[int]],
    limit: int = MAX_UNNAMED,
) -> list[dict[str, Any]]:
    """The leading run of ``unnamed`` (most-seen first) appearing in >= ``min_photos`` photos.

    Binary search for the first person below the threshold; ``photo_count`` errors
    propagate so the caller can fall back.
    """
    lo, hi = 0, min(len(unnamed), limit + 1)
    while lo < hi:
        mid = (lo + hi) // 2
        if await photo_count(unnamed[mid]["id"]) >= min_photos:
            lo = mid + 1
        else:
            hi = mid
    return unnamed[: min(lo, limit)]
