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


def test_landmarks_nan_serializes_as_null(client, tmp_path, monkeypatch):
    import numpy as np
    import webtool.server as srv
    # El endpoint sirve el npy de disco (la extracción va en background):
    # dejar el archivo listo en un OUTPUT_DIR temporal.
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    lm = np.ones((2, 33, 4), dtype=np.float32)
    lm[0, 0, 0] = np.nan
    np.save(srv.landmarks_npy_path("PopUpLateral.mov"), lm)
    resp = client.get("/api/landmarks/PopUpLateral.mov")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["n_frames"] == 2
    assert data["landmarks"][0][0][0] is None      # the NaN became null
    assert data["landmarks"][0][0][1] == 1.0        # non-NaN preserved


def test_worldlandmarks_shape_and_nan(client, tmp_path, monkeypatch):
    import numpy as np
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    world = np.ones((2, 33, 4), dtype=np.float32)
    world[0, 0, 0] = np.nan
    np.save(srv.worldlandmarks_npy_path("PopUpLateral.mov"), world)
    resp = client.get("/api/worldlandmarks/PopUpLateral.mov")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["n_frames"] == 2
    assert len(data["landmarks"][0]) == 33
    assert data["landmarks"][0][0][0] is None      # NaN -> null
    assert data["landmarks"][0][0][1] == 1.0


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


def test_annotations_post_rejects_malformed_body(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    # a JSON array (not an object) must be rejected
    resp = client.post("/api/annotations/PopUpLateral.mov", json=[1, 2, 3])
    assert resp.status_code == 400


def test_sequence_roundtrip(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    post = client.post("/api/sequence/PopUpLateral.mov",
                       json={"video": "PopUpLateral.mov", "steps": [10, 50, 120]})
    assert post.status_code == 200
    got = client.get("/api/sequence/PopUpLateral.mov").get_json()
    assert got["steps"] == [10, 50, 120]


def test_sequence_empty_default(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    got = client.get("/api/sequence/PopUpLateral.mov").get_json()
    assert got["steps"] == []


def test_library_roundtrip(client, tmp_path, monkeypatch):
    import webtool.server as srv
    # LIBRARY_PATH se computa al importar: parchear el path, no OUTPUT_DIR.
    monkeypatch.setattr(srv, "LIBRARY_PATH", str(tmp_path / "library.json"))
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    got = client.get("/api/library").get_json()
    assert got["videos"] == {}
    assert "pop-up" in got["maniobras"]

    payload = {"videos": {"PopUpLateral.mov":
                          {"maniobra": "pop-up", "persona": "Jesu", "rol": "alumno"}}}
    post = client.post("/api/library", json=payload)
    assert post.status_code == 200
    assert post.get_json()["ok"] is True

    got = client.get("/api/library").get_json()
    assert got["videos"]["PopUpLateral.mov"]["rol"] == "alumno"
    assert "maniobras" in got   # taxonomía por defecto se agrega al guardar


def test_library_post_rejects_malformed(client, tmp_path, monkeypatch):
    import webtool.server as srv
    monkeypatch.setattr(srv, "LIBRARY_PATH", str(tmp_path / "library.json"))
    assert client.post("/api/library", json=[1, 2]).status_code == 400
    assert client.post("/api/library", json={"videos": "no-dict"}).status_code == 400


def test_worldlandmarks_smooth_param(client, tmp_path, monkeypatch):
    import numpy as np
    import webtool.server as srv
    monkeypatch.setattr(srv, "OUTPUT_DIR", str(tmp_path))
    n = 40
    rng = np.random.default_rng(0)
    world = rng.normal(size=(n, 33, 4)).astype(np.float32)
    world[:, :, 3] = 1.0
    np.save(srv.worldlandmarks_npy_path("PopUpLateral.mov"), world)

    raw = client.get("/api/worldlandmarks/PopUpLateral.mov").get_json()
    sm = client.get("/api/worldlandmarks/PopUpLateral.mov?smooth=1").get_json()
    assert raw["n_frames"] == sm["n_frames"] == n
    xs_raw = [raw["landmarks"][f][0][0] for f in range(n)]
    xs_sm = [sm["landmarks"][f][0][0] for f in range(n)]
    assert xs_raw != xs_sm                      # el suavizado cambió la serie
    jitter = lambda xs: sum(abs(xs[i + 1] - xs[i]) for i in range(n - 1))
    assert jitter(xs_sm) < jitter(xs_raw)       # y de verdad la alisa
