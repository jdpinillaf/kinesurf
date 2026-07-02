"""Blueprint del dashboard de coach: páginas + API de estudiantes.

Vive en archivos propios (store.py + students.py) para que el diff sobre
server.py sea mínimo (import + register_blueprint) y no colisione con el
workstream de extracción/render.
"""
from __future__ import annotations

import os

from flask import Blueprint, abort, jsonify, request, send_from_directory

from webtool import store

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

bp = Blueprint("students", __name__)


@bp.get("/dashboard")
def dashboard_page():
    return send_from_directory(STATIC_DIR, "dashboard.html")


@bp.get("/student")
def student_page():
    return send_from_directory(STATIC_DIR, "student.html")


@bp.get("/api/students")
def api_students():
    # Migración lazy: primer acceso convierte las `persona` de library.json.
    store.migrate_library_personas()
    return jsonify(students=store.students_summary())


@bp.post("/api/students")
def api_create_student():
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("nombre"), str) \
            or not data["nombre"].strip():
        abort(400)
    student = store.new_student(
        nombre=data["nombre"].strip(),
        nivel=str(data.get("nivel") or ""),
        notas=str(data.get("notas") or ""),
    )
    return jsonify(student)


@bp.patch("/api/students/<sid>")
def api_update_student(sid: str):
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        abort(400)
    if "nombre" in data and (not isinstance(data["nombre"], str)
                             or not data["nombre"].strip()):
        abort(400)
    student = store.update_student(sid, data)
    if student is None:
        abort(404)
    return jsonify(student)


@bp.get("/api/students/<sid>/videos")
def api_student_videos(sid: str):
    if sid not in store.load_students()["students"]:
        abort(404)
    return jsonify(videos=store.student_videos(sid))


@bp.get("/api/videos/unassigned")
def api_unassigned_videos():
    # Import local para leer list_videos con los paths (parcheados) de server.
    from webtool import server
    return jsonify(videos=store.unassigned_videos(server.list_videos()))


@bp.post("/api/library/assign")
def api_assign_video():
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("video"), str):
        abort(400)
    video = data["video"]
    if not os.path.isfile(os.path.join(store.RAW_DIR, video)) \
            or "/" in video or "\\" in video:
        abort(404)
    student_id = data.get("student_id")
    if student_id is not None:
        if not isinstance(student_id, str) \
                or student_id not in store.load_students()["students"]:
            abort(404)
    entry = store.assign_video(video, student_id,
                               fecha=data.get("fecha"), nota=data.get("nota"))
    return jsonify(ok=True, entry=entry)
