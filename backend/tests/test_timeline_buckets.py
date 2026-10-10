from app.timeline_buckets import is_month, month_items, normalize_buckets


def test_buckets_are_months_newest_first():
    raw = [
        {"timeBucket": "2012-03-01", "count": 5},
        {"timeBucket": "2025-10-01T00:00:00.000Z", "count": 40},
        {"timeBucket": "2019-07-01", "count": 12},
    ]
    assert normalize_buckets(raw) == [
        {"month": "2025-10", "count": 40},
        {"month": "2019-07", "count": 12},
        {"month": "2012-03", "count": 5},
    ]


def test_duplicate_months_merge_and_junk_is_dropped():
    raw = [
        {"timeBucket": "2020-01-01", "count": 3},
        {"timeBucket": "2020-01-01T00:00:00Z", "count": 2},
        {"timeBucket": "not a date", "count": 9},
        {"timeBucket": "2021-05-01", "count": 0},
        {"timeBucket": "2021-06-01", "count": "x"},
        "nope",
    ]
    assert normalize_buckets(raw) == [{"month": "2020-01", "count": 5}]


def test_non_list_input_gives_no_buckets():
    assert normalize_buckets({"error": "nope"}) == []


def test_month_items_wall_clock_and_types():
    raw = {
        "id": ["a", "b", "c", "d"],
        "isImage": [True, False, True, True],
        "visibility": ["timeline", "timeline", "archive", "timeline"],
        "isTrashed": [False, False, False, True],
        "fileCreatedAt": ["2024-02-10T03:30:00.000Z", "2024-02-09T12:00:00Z", "2024-02-08T00:00:00Z", "2024-02-07T00:00:00Z"],
        "localOffsetHours": [5.5, 0, 0, 0],
    }
    assert month_items(raw) == [
        {"id": "a", "type": "IMAGE", "localDateTime": "2024-02-10T09:00:00.000Z"},
        {"id": "b", "type": "VIDEO", "localDateTime": "2024-02-09T12:00:00.000Z"},
    ]


def test_month_items_tolerates_junk():
    assert month_items(None) == []
    assert month_items({"id": "nope"}) == []
    assert month_items({"id": ["a", 5], "fileCreatedAt": ["bad", "2024-01-01T00:00:00Z"]}) == []
    # missing optional columns -> defaults
    assert month_items({"id": ["a"], "fileCreatedAt": ["2024-01-01T00:00:00Z"]}) == [
        {"id": "a", "type": "IMAGE", "localDateTime": "2024-01-01T00:00:00.000Z"}
    ]


def test_is_month():
    assert is_month("2024-02") and is_month("1999-12")
    assert not is_month("2024-00") and not is_month("2024-2") and not is_month("")
