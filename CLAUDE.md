# Surf Pop-Up Analyzer — Fase 0 (Notebook de Validación)

## Qué es esto
Notebook de Python para validar si la pose estimation produce métricas biomecánicas
útiles a partir de videos del **pop-up de surf grabados en tierra** (en seco, no en agua).
Este es un experimento de validación, NO un producto. El objetivo es decidir, con datos,
si vale la pena construir el producto completo después.

## Objetivo concreto de esta fase
Dado un video lateral de una persona haciendo un pop-up en tierra, el notebook debe:
1. Extraer la pose (33 landmarks) frame por frame.
2. Detectar las fases del pop-up (prono → push → transición → stance).
3. Calcular 6 métricas biomecánicas.
4. Renderizar un video con el esqueleto y los ángulos dibujados encima.
5. Exportar las métricas a CSV.

## Criterio de éxito (esto es lo que el notebook debe ayudar a responder)
- Los landmarks tienen confianza > 0.7 en > 90% de los frames de las fases de transición y stance.
- Las métricas SEPARAN VISIBLEMENTE a un surfista avanzado de un principiante.
  (Ej. esperado: pop-up < 1.0s avanzado vs > 1.5s principiante; rodillas ~90-110° avanzado
  vs > 140° principiante.)
Si ambos se cumplen, la fase de producto se justifica. El notebook es la herramienta para verlo.

---

## Stack (decisiones ya tomadas — NO proponer alternativas)
- Python 3.11+
- `mediapipe` (Pose Landmarker, model_complexity=2, con smoothing)
- `opencv-python` (lectura/escritura de video, dibujo)
- `numpy` (series temporales de landmarks)
- `scipy` (filtro Savitzky-Golay para suavizado)
- `pandas` (export CSV)
- `matplotlib` (gráfico de timeline de fases)
- Jupyter notebook como interfaz principal, con la lógica en módulos `.py` importables.

NO usar: PyTorch, entrenamiento de modelos, RTMPose (es el plan B, no ahora), frameworks web,
bases de datos, Docker. Esta fase es solo el notebook y sus módulos.

---

## Estructura de archivos esperada
```
surf-popup-analyzer/
├── requirements.txt
├── README.md                 # cómo correrlo + protocolo de grabación de videos
├── notebook.ipynb            # interfaz: corre el pipeline sobre los videos y muestra resultados
├── data/
│   ├── raw/                  # videos de entrada (gitignored)
│   └── output/               # videos anotados + CSVs (gitignored)
└── src/
    ├── pose.py               # extracción de landmarks con MediaPipe
    ├── smoothing.py          # filtro Savitzky-Golay sobre trayectorias
    ├── phases.py             # detección de fases del pop-up (LÓGICA DE DOMINIO — ver abajo)
    ├── metrics.py            # cálculo de las 6 métricas
    ├── render.py             # video anotado (esqueleto + ángulos) con OpenCV
    └── report.py             # export a CSV + gráfico de timeline
```

---

## Detalle de la lógica de dominio (lo más importante — leer con cuidado)

### Landmarks de MediaPipe relevantes (índices)
- Nariz: 0
- Hombros: 11 (izq), 12 (der)
- Codos: 13, 14 — Muñecas: 15, 16
- Caderas: 23, 24 — Rodillas: 25, 26 — Tobillos: 27, 28

### Detección de fases del pop-up
El pop-up es la transición de estar acostado (prono) sobre la tabla a estar de pie en
posición de surf. Dura aproximadamente 1 segundo. Se detecta por las alturas relativas
(coordenada y, recordando que en imagen y crece hacia abajo) de muñecas, caderas y tobillos:

1. **Prono**: cuerpo horizontal, caderas y hombros a altura similar, muñecas cerca del piso.
2. **Push**: extensión de codos, hombros suben, muñecas quedan debajo de los hombros.
   (detectar por ángulo de codo aumentando + altura de hombros subiendo)
3. **Transición**: las caderas suben y los pies viajan hacia adelante bajo el cuerpo.
   (detectar por caderas subiendo + tobillos moviéndose en x hacia la línea de las manos)
4. **Stance**: posición final de pie. Pies plantados y separados, rodillas y cadera
   flexionadas, manos sueltas. Estado estable.
   (detectar por estabilización de la posición de tobillos + rodillas flexionadas)

Implementar como una máquina de estados que recorre la serie temporal y marca el frame de
inicio de cada fase. Exponer los timestamps de cada fase (se reutilizarán en producto para
sincronización side-by-side, pero AQUÍ solo se necesitan para las métricas y el gráfico).

### Las 6 métricas (v1 — versionar como tales, van a cambiar)
1. **Tiempo de pop-up**: segundos desde inicio del push hasta stance estable.
2. **Flexión de rodilla** (delantera y trasera) en stance: ángulo cadera-rodilla-tobillo en grados.
3. **Ángulo de cadera (hinge)** en stance: ángulo hombro-cadera-rodilla.
4. **Ancho de stance**: distancia horizontal entre tobillos, normalizada por estatura estimada
   (la estatura se estima como distancia vertical nariz-tobillo en el frame prono).
5. **Simetría hombros/caderas**: ángulo de inclinación lateral de la línea de hombros y de la
   línea de caderas respecto a la horizontal, en stance.
6. **Orientación de cabeza**: posición de la nariz respecto al punto medio de los hombros
   (proxy de si mira al frente o hacia los pies).

Todas las métricas se calculan en la fase de stance salvo el tiempo de pop-up. Cada ángulo
se calcula con `arccos` del producto punto de los dos vectores que forman la articulación.

---

## Inputs (lo que el usuario va a proveer)
Videos en `data/raw/`. Specs de grabación (documentar en el README para que el usuario los
siga al grabar):
- Plano LATERAL fijo (trípode o apoyado), cuerpo completo en cuadro.
- 1080p mínimo, **60fps** (el gesto dura ~1s; a 30fps se pierden los picos).
- Buena luz, fondo despejado.
- La persona empieza acostada (prono) y ejecuta un pop-up completo.

El notebook debe manejar con gracia: video que no es 60fps (avisar pero procesar),
frames donde MediaPipe no detecta pose (interpolar o marcar baja confianza), y videos de
distinta resolución.

---

## Outputs esperados por video
1. **Video anotado** (`data/output/<nombre>_annotated.mp4`): esqueleto dibujado + ángulos de
   rodilla/cadera escritos sobre las articulaciones + etiqueta de la fase actual en pantalla.
   Este video es el entregable que se le muestra al coach (la demo), así que debe verse limpio.
2. **CSV** (`data/output/metrics.csv`): una fila por video con las 6 métricas + % de frames
   con confianza > 0.7 + nombre del archivo.
3. **Gráfico de timeline** (en el notebook): las 4 fases sobre el eje de tiempo del video.

---

## Restricciones y advertencias (qué NO hacer)
- NO sobre-construir. Es un notebook de validación, no un producto. Sin auth, sin API,
  sin DB, sin UI web, sin Docker.
- NO inventar métricas adicionales más allá de las 6. Si surge una idea, dejarla comentada
  como TODO, no implementarla.
- NO intentar analizar video en agua. Esta fase es SOLO tierra.
- NO usar deep learning custom ni entrenar nada. MediaPipe pre-entrenado es la herramienta.
- Código limpio y modular: la lógica en `src/`, el notebook solo orquesta y visualiza.
  La lógica de fases y métricas debe ser fácil de ajustar (los umbrales van a necesitar tuning
  con videos reales — exponerlos como constantes claras al inicio de cada módulo).
- Manejar el caso de video corto/sin pop-up detectable sin crashear: reportar "fase no detectada"
  y seguir.

## Primer entregable que quiero
1. `requirements.txt` y estructura de carpetas.
2. `src/pose.py` funcionando: dado un video, devuelve el array de landmarks `[frames, 33, 4]`
   (x, y, z, visibility) y el % de frames con buena confianza.
3. Una celda en el notebook que corra `pose.py` sobre un video de `data/raw/` y dibuje el
   esqueleto sobre el primer frame, para verificar que la extracción funciona ANTES de seguir
   con fases y métricas.

Construye en ese orden y para a que yo verifique con un video real antes de implementar
`phases.py` y `metrics.py`, porque esos umbrales dependen de ver datos reales.
