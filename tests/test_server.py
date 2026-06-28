import os
import pytest

from webtool.server import create_app


@pytest.fixture
def client():
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def test_list_videos_returns_existing_raw_videos(client):
    resp = client.get("/api/videos")
    assert resp.status_code == 200
    data = resp.get_json()
    assert "videos" in data
    # En data/raw/ hay al menos PopUpLateral.mov en este repo.
    assert any(v.lower().endswith(".mov") for v in data["videos"])


def test_meta_returns_video_dimensions(client):
    resp = client.get("/api/meta/PopUpLateral.mov")
    assert resp.status_code == 200
    m = resp.get_json()
    assert m["n_frames"] > 0
    assert m["width"] > 0 and m["height"] > 0
    assert m["fps"] > 0
    assert isinstance(m["has_landmarks"], bool)


def test_meta_unknown_video_404(client):
    resp = client.get("/api/meta/nope.mov")
    assert resp.status_code == 404


def test_frame_returns_jpeg(client):
    resp = client.get("/api/frame/PopUpLateral.mov/0")
    assert resp.status_code == 200
    assert resp.mimetype == "image/jpeg"
    # JPEG empieza con los magic bytes FF D8.
    assert resp.data[:2] == b"\xff\xd8"


def test_frame_out_of_range_clamps(client):
    resp = client.get("/api/frame/PopUpLateral.mov/999999")
    assert resp.status_code == 200
    assert resp.data[:2] == b"\xff\xd8"
