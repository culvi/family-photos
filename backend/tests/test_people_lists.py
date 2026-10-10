from app.people_lists import split_people


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
