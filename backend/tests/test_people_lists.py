import asyncio

from app.people_lists import split_people, unnamed_with_min_photos


def person(pid, name="", hidden=False):
    return {"id": pid, "name": name, "isHidden": hidden}


# Immich order: named first, then unnamed by face count (most photos first)
IMMICH_ORDER = [
    person("n1", "zoe"),
    person("n2", "Amy"),
    person("u1"),
    person("u2", "   "),
    person("u3", hidden=True),
    person("u4"),
]


def test_named_people_are_sorted_by_name_case_insensitively():
    named, _ = split_people(IMMICH_ORDER)
    assert [p["id"] for p in named] == ["n2", "n1"]


def test_unnamed_keep_immichs_most_seen_order_and_skip_hidden_and_blank_names():
    _, unnamed = split_people(IMMICH_ORDER)
    assert [p["id"] for p in unnamed] == ["u1", "u2", "u4"]


def test_unnamed_list_is_capped():
    _, unnamed = split_people(IMMICH_ORDER, unnamed_limit=2)
    assert [p["id"] for p in unnamed] == ["u1", "u2"]


def test_album_scope_restricts_both_lists():
    named, unnamed = split_people(IMMICH_ORDER, allowed={"n1", "u4"})
    assert [p["id"] for p in named] == ["n1"]
    assert [p["id"] for p in unnamed] == ["u4"]


def _run(coro):
    return asyncio.run(coro)


def _counted(counts):
    calls = []

    async def photo_count(pid):
        calls.append(pid)
        return counts[pid]

    return photo_count, calls


def test_min_photos_cutoff_found_by_binary_search():
    counts = {f"u{i}": c for i, c in enumerate([90, 40, 12, 9, 5, 5, 4, 3, 3, 3, 3, 3])}
    unnamed = [{"id": pid} for pid in counts]
    photo_count, calls = _counted(counts)

    result = _run(unnamed_with_min_photos(unnamed, 5, photo_count))

    assert [p["id"] for p in result] == ["u0", "u1", "u2", "u3", "u4", "u5"]
    assert len(calls) <= 5  # log2(12) lookups, not 12


def test_everyone_or_no_one_above_the_threshold():
    unnamed = [{"id": "a"}, {"id": "b"}]
    high, _ = _counted({"a": 50, "b": 6})
    low, _ = _counted({"a": 4, "b": 3})
    assert len(_run(unnamed_with_min_photos(unnamed, 5, high))) == 2
    assert _run(unnamed_with_min_photos(unnamed, 5, low)) == []
    assert _run(unnamed_with_min_photos([], 5, low)) == []


def test_result_is_capped():
    counts = {f"u{i}": 100 for i in range(20)}
    unnamed = [{"id": pid} for pid in counts]
    photo_count, _ = _counted(counts)
    assert len(_run(unnamed_with_min_photos(unnamed, 5, photo_count, limit=7))) == 7


def test_lookup_errors_propagate_so_the_route_can_fall_back():
    async def broken(pid):
        raise ValueError("no permission")

    try:
        _run(unnamed_with_min_photos([{"id": "a"}], 5, broken))
    except ValueError:
        return
    raise AssertionError("expected the error to propagate")
