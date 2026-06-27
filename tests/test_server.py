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
