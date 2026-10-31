from app.tabs.songsterr import audio_sources_from_videos, classify_track

TRACKS = [
    {"index": 0, "name": "Singer | Lead Vocals", "hash": "vocals_a", "kind": "vocals"},
    {"index": 1, "name": "Player | Rhythm Guitar", "hash": "guitar_b", "kind": "guitar"},
    {"index": 2, "name": "Player | Bass", "hash": "bass_c", "kind": "bass"},
]


def test_classify_track():
    assert classify_track({"hash": "guitar_x"}) == "guitar"
    assert classify_track({"hash": "guitar_x", "tuning": [64, 59, 55, 50, 45, 40]}) == "guitar"
    assert classify_track({"hash": "guitar_x", "tuning": [64, 59, 55, 50, 45, 40, 35]}) == "other"
    assert classify_track({"hash": "x", "isVocalTrack": True}) == "vocals"
    assert classify_track({"hash": "drums_x"}) == "drums"


def test_sources_from_videos():
    videos = [
        {"status": "done", "feature": "backing", "videoId": "bbbbbbbbbbb", "trackHashes": ["guitar_b"], "points": [0.5, 2.5]},
        {"status": "done", "feature": None, "videoId": "ooooooooooo", "points": [0.2, 2.2, 4.2]},
        {"status": "done", "feature": "solo", "videoId": "sssssssssss", "trackHashes": ["bass_c"], "points": [0, 2]},
        {"status": "failed", "feature": "backing", "videoId": "xxxxxxxxxxx", "points": [1]},
    ]
    sources = audio_sources_from_videos(videos, TRACKS)
    ids = [s["id"] for s in sources]
    assert ids[0] == "original"
    assert "backing-xxxxxxxxxxx" not in ids
    backing = next(s for s in sources if s["kind"] == "backing")
    assert backing["label"] == "No Rhythm Guitar"
    assert backing["guitarOnlyRemoved"] is True
    assert sources[0]["syncPoints"][1] == {"barIndex": 1, "occurrence": 0, "seconds": 2.2}


def test_alternative_promoted_when_no_main_video():
    videos = [{"status": "done", "feature": "alternative", "videoId": "aaaaaaaaaaa", "points": [1, 2]}]
    sources = audio_sources_from_videos(videos, TRACKS)
    assert sources[0]["id"] == "original" and sources[0]["videoId"] == "aaaaaaaaaaa"
