from app.timeline_buckets import normalize_buckets


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
