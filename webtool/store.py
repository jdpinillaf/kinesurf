"""Persistencia de estudiantes del dashboard de coach.

Sigue el patrón de server.py: JSON plano en data/output/ con paths module-level
parcheables desde los tests (monkeypatch). Toda la persistencia de estudiantes
pasa por este módulo — migrar a otra base de datos después es reescribir este
archivo, no la app.

Modelo:
- students.json: {"version": 1, "students": {"<id>": {...}}} con id = slug estable.
- library.json (de server.py) gana claves ADITIVAS por video: student_id, fecha, nota.
  student_id null/ausente = video de referencia (profesor) o sin asignar.
"""
from __future__ import annotations

import datetime
import json
import os
import re
import unicodedata

RAW_DIR = "data/raw"
OUTPUT_DIR = "data/output"
STUDENTS_PATH = os.path.join(OUTPUT_DIR, "students.json")
LIBRARY_PATH = os.path.join(OUTPUT_DIR, "library.json")
VIDEO_EXTS = (".mov", ".mp4", ".avi", ".mkv")


# --- IO básico ---------------------------------------------------------------

def load_students() -> dict:
    if os.path.isfile(STUDENTS_PATH):
        with open(STUDENTS_PATH) as f:
            return json.load(f)
    return {"version": 1, "students": {}}


def save_students(data: dict) -> None:
    os.makedirs(os.path.dirname(STUDENTS_PATH) or ".", exist_ok=True)
    with open(STUDENTS_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def load_library() -> dict:
    if os.path.isfile(LIBRARY_PATH):
        with open(LIBRARY_PATH) as f:
            return json.load(f)
    return {"videos": {}}


def save_library(data: dict) -> None:
    os.makedirs(os.path.dirname(LIBRARY_PATH) or ".", exist_ok=True)
    with open(LIBRARY_PATH, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


# --- Estudiantes -------------------------------------------------------------

def slugify(nombre: str) -> str:
    s = unicodedata.normalize("NFKD", nombre).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "estudiante"


def _unique_id(nombre: str, existing: dict) -> str:
    base = f"s-{slugify(nombre)}"
    sid, n = base, 2
    while sid in existing:
        sid = f"{base}-{n}"
        n += 1
    return sid


def new_student(nombre: str, nivel: str = "", notas: str = "") -> dict:
    data = load_students()
    sid = _unique_id(nombre, data["students"])
    student = {
        "id": sid,
        "nombre": nombre,
        "nivel": nivel,
        "notas": notas,
        "foto": None,
        "creado": datetime.date.today().isoformat(),
        "archivado": False,
    }
    data["students"][sid] = student
    save_students(data)
    return student


EDITABLE_FIELDS = ("nombre", "nivel", "notas", "archivado")


def update_student(sid: str, fields: dict) -> dict | None:
    """Actualiza campos editables. Devuelve el estudiante o None si no existe."""
    data = load_students()
    student = data["students"].get(sid)
    if student is None:
        return None
    for k in EDITABLE_FIELDS:
        if k in fields:
            student[k] = fields[k]
    save_students(data)
    return student


# --- Migración persona -> Estudiante ----------------------------------------

def migrate_library_personas() -> None:
    """Crea estudiantes a partir de las `persona` con rol=alumno de library.json.

    Idempotente: solo corre si students.json aún no existe. Videos con
    rol=profesor quedan como referencia (sin student_id); videos sin rol quedan
    "sin asignar" para que el coach los asigne a mano (no adivinar).
    """
    if os.path.isfile(STUDENTS_PATH):
        return
    library = load_library()
    videos = library.get("videos", {})
    data = {"version": 1, "students": {}}
    by_persona: dict[str, str] = {}
    changed = False
    for video, tag in videos.items():
        if not isinstance(tag, dict) or tag.get("rol") != "alumno":
            continue
        persona = (tag.get("persona") or "").strip()
        if not persona:
            continue
        sid = by_persona.get(persona)
        if sid is None:
            sid = _unique_id(persona, data["students"])
            data["students"][sid] = {
                "id": sid,
                "nombre": persona,
                "nivel": "",
                "notas": "",
                "foto": None,
                "creado": datetime.date.today().isoformat(),
                "archivado": False,
            }
            by_persona[persona] = sid
        if tag.get("student_id") != sid:
            tag["student_id"] = sid
            changed = True
    save_students(data)
    if changed:
        save_library(library)


# --- Joins con la librería ----------------------------------------------------

def _video_fecha(video: str, tag: dict) -> str | None:
    """Fecha del video: la etiquetada, o la de modificación del archivo."""
    if tag.get("fecha"):
        return tag["fecha"]
    path = os.path.join(RAW_DIR, video)
    if os.path.isfile(path):
        return datetime.date.fromtimestamp(os.path.getmtime(path)).isoformat()
    return None


def _video_entry(video: str, tag: dict) -> dict:
    return {
        "video": video,
        "maniobra": tag.get("maniobra") or "",
        "rol": tag.get("rol") or "",
        "student_id": tag.get("student_id"),
        "fecha": _video_fecha(video, tag),
        "nota": tag.get("nota") or "",
    }


def student_videos(sid: str) -> list[dict]:
    videos = load_library().get("videos", {})
    out = [_video_entry(v, t) for v, t in videos.items()
           if isinstance(t, dict) and t.get("student_id") == sid]
    return sorted(out, key=lambda e: (e["fecha"] or "", e["video"]), reverse=True)


def unassigned_videos(raw_videos: list[str]) -> list[dict]:
    """Videos presentes en data/raw sin student_id y sin rol=profesor."""
    videos = load_library().get("videos", {})
    out = []
    for v in raw_videos:
        tag = videos.get(v) or {}
        if not isinstance(tag, dict):
            tag = {}
        if tag.get("student_id") or tag.get("rol") == "profesor":
            continue
        out.append(_video_entry(v, tag))
    return out


def students_summary() -> list[dict]:
    """Estudiantes + resumen computado (nº videos, última fecha, maniobras)."""
    students = load_students()["students"]
    videos = load_library().get("videos", {})
    per_student: dict[str, list[dict]] = {}
    for v, t in videos.items():
        if isinstance(t, dict) and t.get("student_id"):
            per_student.setdefault(t["student_id"], []).append(_video_entry(v, t))
    out = []
    for sid, student in students.items():
        vids = per_student.get(sid, [])
        fechas = [e["fecha"] for e in vids if e["fecha"]]
        out.append({
            **student,
            "n_videos": len(vids),
            "ultima_fecha": max(fechas) if fechas else None,
            "maniobras": sorted({e["maniobra"] for e in vids if e["maniobra"]}),
        })
    return sorted(out, key=lambda s: s["nombre"].lower())


def assign_video(video: str, student_id: str | None,
                 fecha: str | None = None, nota: str | None = None) -> dict:
    """Escritura puntual sobre library.json: asigna/desasigna un video.

    Preserva las claves existentes del tag (maniobra, persona, rol...).
    """
    library = load_library()
    videos = library.setdefault("videos", {})
    tag = videos.get(video)
    if not isinstance(tag, dict):
        tag = {}
        videos[video] = tag
    tag["student_id"] = student_id
    if fecha is not None:
        tag["fecha"] = fecha
    elif student_id and not tag.get("fecha"):
        f = _video_fecha(video, tag)
        if f:
            tag["fecha"] = f
    if nota is not None:
        tag["nota"] = nota
    save_library(library)
    return _video_entry(video, tag)
