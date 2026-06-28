# Smoke test — motor visual de etiquetado

1. navegar a http://127.0.0.1:5000  → el dropdown tiene PopUpLateral.mov, frame 0 visible.
2. click ▶ 5 veces → frameLabel = "5 / 200", imagen cambia.
3. activar "ángulo", clickear 3 puntos → aparece arco verde con grados.
4. activar "dibujo", arrastrar → aparece trazo rojo.
5. click "guardar" → status muestra "guardado ✓".
6. recargar la página → las anotaciones del frame reaparecen.
7. verificar que existe data/output/PopUpLateral_annotations.json con corrections/angles/drawings.
