import json
import os

import pytest

import webtool.store as store
from webtool.server import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    # Aislar TODA la persistencia de estudiantes/librería en tmp_path.
    monkeypatch.setattr(store, "STUDENTS_PATH", str(tmp_path / "students.json"))
    monkeypatch.setattr(store, "LIBRARY_PATH", str(tmp_path / "library.json"))
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


def seed_library(payload: dict):
    with open(store.LIBRARY_PATH, "w") as f:
        json.dump(payload, f)


def test_students_empty_default(client):
    got = client.get("/api/students").get_json()
    assert got["students"] == []


def test_create_student_and_summary(client):
    post = client.post("/api/students", json={"nombre": "Ana García",
                                              "nivel": "intermedio"})
    assert post.status_code == 200
    student = post.get_json()
    assert student["id"] == "s-ana-garcia"      # slug sin tildes
    assert student["archivado"] is False

    got = client.get("/api/students").get_json()["students"]
    assert len(got) == 1
    assert got[0]["nombre"] == "Ana García"
    assert got[0]["n_videos"] == 0
    assert got[0]["maniobras"] == []


def test_create_student_id_collision_gets_suffix(client):
    a = client.post("/api/students", json={"nombre": "Ana"}).get_json()
    b = client.post("/api/students", json={"nombre": "ana"}).get_json()
    assert a["id"] == "s-ana"
    assert b["id"] == "s-ana-2"


def test_create_student_rejects_malformed(client):
    assert client.post("/api/students", json=[1, 2]).status_code == 400
    assert client.post("/api/students", json={"nombre": "  "}).status_code == 400
    assert client.post("/api/students", json={}).status_code == 400


def test_patch_student_updates_and_archives(client):
    sid = client.post("/api/students", json={"nombre": "Ana"}).get_json()["id"]
    patch = client.patch(f"/api/students/{sid}",
                         json={"nivel": "avanzado", "archivado": True,
                               "notas": "trabajar hombros"})
    assert patch.status_code == 200
    got = patch.get_json()
    assert got["nivel"] == "avanzado"
    assert got["archivado"] is True
    assert got["notas"] == "trabajar hombros"


def test_patch_unknown_student_404(client):
    assert client.patch("/api/students/s-nope", json={"nivel": "x"}).status_code == 404


def test_patch_rejects_empty_nombre(client):
    sid = client.post("/api/students", json={"nombre": "Ana"}).get_json()["id"]
    assert client.patch(f"/api/students/{sid}", json={"nombre": ""}).status_code == 400


def test_migration_creates_students_from_personas(client):
    seed_library({"videos": {
        "estudiante_carving.mov": {"maniobra": "carving", "persona": "Alumno",
                                   "rol": "alumno"},
        "profesor_carving.mp4": {"maniobra": "carving", "persona": "Profe",
                                 "rol": "profesor"},
        "PopUpLateral.mov": {"maniobra": "pop-up", "persona": "Jesu"},
    }})
    got = client.get("/api/students").get_json()["students"]
    # Solo rol=alumno migra; profesor = referencia; sin rol = sin asignar.
    assert [s["id"] for s in got] == ["s-alumno"]
    assert got[0]["n_videos"] == 1
    assert got[0]["maniobras"] == ["carving"]
    # La migración escribió student_id en library.json (claves preservadas).
    lib = json.load(open(store.LIBRARY_PATH))
    assert lib["videos"]["estudiante_carving.mov"]["student_id"] == "s-alumno"
    assert lib["videos"]["estudiante_carving.mov"]["persona"] == "Alumno"
    assert "student_id" not in lib["videos"]["profesor_carving.mp4"]


def test_migration_is_idempotent(client):
    seed_library({"videos": {
        "estudiante_carving.mov": {"persona": "Alumno", "rol": "alumno"},
    }})
    first = client.get("/api/students").get_json()["students"]
    second = client.get("/api/students").get_json()["students"]
    assert first == second
    assert len(second) == 1


def test_student_videos_join(client):
    sid = client.post("/api/students", json={"nombre": "Ana"}).get_json()["id"]
    seed_library({"videos": {
        "PopUpLateral.mov": {"maniobra": "pop-up", "student_id": sid,
                             "fecha": "2026-06-28", "nota": "mejor entrada"},
    }})
    got = client.get(f"/api/students/{sid}/videos").get_json()["videos"]
    assert len(got) == 1
    assert got[0]["video"] == "PopUpLateral.mov"
    assert got[0]["fecha"] == "2026-06-28"
    assert got[0]["nota"] == "mejor entrada"

    assert client.get("/api/students/s-nope/videos").status_code == 404


def test_assign_and_unassign_video(client):
    sid = client.post("/api/students", json={"nombre": "Ana"}).get_json()["id"]
    seed_library({"videos": {
        "PopUpLateral.mov": {"maniobra": "pop-up", "persona": "Jesu"},
    }})
    post = client.post("/api/library/assign",
                       json={"video": "PopUpLateral.mov", "student_id": sid,
                             "fecha": "2026-07-01"})
    assert post.status_code == 200
    entry = post.get_json()["entry"]
    assert entry["student_id"] == sid
    # Claves previas del tag preservadas.
    lib = json.load(open(store.LIBRARY_PATH))
    assert lib["videos"]["PopUpLateral.mov"]["maniobra"] == "pop-up"
    assert lib["videos"]["PopUpLateral.mov"]["persona"] == "Jesu"

    # Desasignar: student_id null.
    post = client.post("/api/library/assign",
                       json={"video": "PopUpLateral.mov", "student_id": None})
    assert post.status_code == 200
    assert post.get_json()["entry"]["student_id"] is None


def test_assign_validates_video_and_student(client):
    sid = client.post("/api/students", json={"nombre": "Ana"}).get_json()["id"]
    r = client.post("/api/library/assign",
                    json={"video": "nope.mov", "student_id": sid})
    assert r.status_code == 404
    r = client.post("/api/library/assign",
                    json={"video": "PopUpLateral.mov", "student_id": "s-nope"})
    assert r.status_code == 404
    assert client.post("/api/library/assign", json=[1]).status_code == 400


def test_unassigned_videos_excludes_assigned_and_references(client):
    sid = client.post("/api/students", json={"nombre": "Ana"}).get_json()["id"]
    seed_library({"videos": {
        "PopUpLateral.mov": {"student_id": sid},
        "profesor_carving.mp4": {"rol": "profesor"},
    }})
    got = client.get("/api/videos/unassigned").get_json()["videos"]
    names = [v["video"] for v in got]
    assert "PopUpLateral.mov" not in names
    assert "profesor_carving.mp4" not in names
    # Los demás videos reales de data/raw sí aparecen.
    assert all(n.lower().endswith((".mov", ".mp4", ".avi", ".mkv")) for n in names)


def test_dashboard_and_student_pages_serve_html(client):
    for route in ("/dashboard", "/student?id=s-x"):
        resp = client.get(route)
        assert resp.status_code == 200
        assert b"<!doctype html" in resp.data.lower()
