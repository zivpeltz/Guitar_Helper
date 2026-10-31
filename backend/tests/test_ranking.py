from app.audio.youtube import score_candidate


def test_official_audio_beats_cover():
    official = {"title": "Oasis - Wonderwall (Official Audio)", "channel": "Oasis", "duration": 259}
    cover = {"title": "Wonderwall cover (acoustic lesson)", "channel": "someone", "duration": 250}
    assert score_candidate(official, "Oasis", "Wonderwall", "original") > score_candidate(cover, "Oasis", "Wonderwall", "original")


def test_backing_requires_keywords_and_similar_length():
    good = {"title": "Wonderwall - Oasis | Guitar Backing Track", "channel": "x", "duration": 262}
    plain = {"title": "Oasis - Wonderwall", "channel": "Oasis", "duration": 259}
    too_long = {"title": "Wonderwall guitar backing track (10 min loop)", "channel": "x", "duration": 600}
    s = lambda c: score_candidate(c, "Oasis", "Wonderwall", "backing", ref_duration=259)  # noqa: E731
    assert s(good) > s(plain)
    assert s(good) > s(too_long)
