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


def test_landmarks_shape(client):
    resp = client.get("/api/landmarks/PopUpLateral.mov")
    assert resp.status_code == 200
    data = resp.get_json()
    lm = data["landmarks"]
    assert data["n_frames"] == len(lm)
    assert len(lm[0]) == 33          # 33 landmarks
    assert len(lm[0][0]) == 4        # x,y,z,vis
    # Coords normalizadas: x del landmark 0 dentro de un margen razonable.
    assert -0.5 < lm[0][0][0] < 1.5


def test_landmarks_nan_serializes_as_null(client, monkeypatch):
    import numpy as np
    import webtool.server as srv
    lm = np.ones((2, 33, 4), dtype=np.float32)
    lm[0, 0, 0] = np.nan
    monkeypatch.setattr(srv, "load_or_extract_landmarks", lambda video: lm)
    resp = client.get("/api/landmarks/PopUpLateral.mov")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["n_frames"] == 2
    assert data["landmarks"][0][0][0] is None      # the NaN became null
    assert data["landmarks"][0][0][1] == 1.0        # non-NaN preserved


def test_annotations_roundtrip(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))

    payload = {
        "video": "PopUpLateral.mov",
        "corrections": {"151": {"25": [0.41, 0.72]}},
        "angles": [{"frame": 151, "points": [[0.4, 0.3], [0.4, 0.7], [0.39, 0.95]],
                    "value": 129.3, "label": "rodilla"}],
        "drawings": {"151": [{"tool": "pen", "stroke": [[0.5, 0.5]], "color": "#ff0000"}]},
    }
    post = client.post("/api/annotations/PopUpLateral.mov", json=payload)
    assert post.status_code == 200
    assert post.get_json()["ok"] is True

    got = client.get("/api/annotations/PopUpLateral.mov").get_json()
    assert got["corrections"]["151"]["25"] == [0.41, 0.72]
    assert got["angles"][0]["value"] == 129.3


def test_annotations_empty_default(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    got = client.get("/api/annotations/PopUpLateral.mov").get_json()
    assert got["corrections"] == {}
    assert got["angles"] == []
    assert got["drawings"] == {}
