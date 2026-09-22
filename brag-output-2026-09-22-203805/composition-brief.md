# Hyperframes Composition Brief: Restaurante Sistema

## Objective
Un video corto de lanzamiento para **Restaurante Sistema**, cuyo argumento es el
control de la plata — no la venta.

## Output
- Composition directory: `brag-output-2026-09-22-203805/composition/`
- Rendered video: `brag-output-2026-09-22-203805/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20.54s

## Source Material
- Project root: `/home/user/restaurante-sistema`
- Primary files read: `frontend/src/index.css` (paleta y fuente), `AGENTS.md` y
  `docs/SPEC-NEGOCIO.md` (las reglas duras), `frontend/src/features/shifts/`
  (el cierre a ciegas), `frontend/src/features/orders/TablesPage.tsx` (el salón)
- Product name: Restaurante Sistema
- Tagline / strongest claim: «Se cuenta a ciegas, y es a propósito.»
- Key UI moment to show: el panel oscuro **«LO QUE EL SISTEMA ESPERA»**, con el
  candado y sus cinco renglones tapados en `•••••`
- Copy que debe aparecer **textual** (sale de la pantalla, no es publicidad):
  - «Se cuenta a ciegas, y es a propósito.»
  - «Si lo vieras antes, dejaría de ser el número que contaste.»
  - «Documento equivalente POS · impuesto discriminado, no sumado»
  - «84 turnos. Cada diferencia, con su causa.»
  - «El control de la plata. No sólo la venta.»

## Creative Direction
- Tone preset: `polished`
- Creative direction: una película corta y sobria sobre plata que no se deja maquillar
- Interpretación: pocas escenas, planos largos, tipografía grande y quieta. La
  energía viene de lo que dice la pantalla. Cero efectos que no existan en el producto.
- Angle: un POS cualquiera te dice cuánto vendiste; éste te dice cuánto falta y
  por qué, y está construido para que ni el software pueda maquillar la
  respuesta. La prueba es una pantalla que esconde información a propósito.
- Hook: el panel del cierre con su candado y la frase real del producto.
- Outro: «El control de la plata. No sólo la venta.»
- Avoid:
  - Lenguaje genérico de SaaS
  - Relleno visual abstracto
  - Rediseñar la UI del producto para el video

## Visual Identity
- Background: `#EDF1F7` · Superficie `#FFFFFF`
- Panel oscuro: `#17202B` (bisel `#26303F`, tinta clara `#EAF0F8`)
- Text: `#0F1B2D` · secundaria `#475569`
- Accent: `#1E40AF` · suave `#E7EDFB`
- Diferencia: rojo `#B91C1C`, ámbar `#B45309`
- Display font: Atkinson Hyperlegible 700 (`assets/fonts/atkinson-700.woff2`)
- Body font: Atkinson Hyperlegible 400 (`assets/fonts/atkinson-400.woff2`)
- Referencias del proyecto: el panel del sello, las tarjetas de mesa, la tabla
  de arqueos con la columna «Diferencia»

## Storyboard
Contrato creativo: `brag-plan.md`.

1. **Se cuenta a ciegas** — 3.70s — captura real del Cierre; se lee
   «Se cuenta a ciegas, y es a propósito.»
2. **Por qué** — 3.70s — los cinco renglones `•••••`; se lee
   «Si lo vieras antes, dejaría de ser el número que contaste.»
3. **El salón, en vivo** — 2.00s — clip real `p2-salon.mp4`
4. **Marchar a cocina** — 2.20s — clip real `p6-cocina.mp4`
5. **El documento** — 2.60s — clip real `p10-documento.mp4`
6. **Y a fin de mes** — 3.71s — captura real de Dinero → Historial; tres chips
   de diferencia entran uno por uno; se lee «84 turnos. Cada diferencia, con su causa.»
7. **Remate** — 2.63s — marca + «El control de la plata. No sólo la venta.»

## Audio
- Audio role: warm bed con acentos escasos y profesionales
- Audio arc: entra desde el silencio con un pestillo, sostiene sin subrayar los
  cortes, marca tres acentos secos en las diferencias, se retira bajo la línea final
- Music: `assets/music/happy-beats-business-moves-vol-9-by-ende-dot-app.mp3`
- Music treatment: fade-in 0→1.2s; volumen sostenido ≈0.55; fade-out en los
  últimos 1.4s
- Music cue guidance: preset en
  `assets/music/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json`
  (114.84 BPM). Strong cues en ventana: 3.70 · 4.23 · 6.34 · 10.54 · 12.65.
  **Lock principal: el corte de escena 1→2 en 3.70s.** Rejilla ≈0.526s; los tres
  chips van en **beats alternos** (14.76 / 15.81 / 16.86), que es lo que deja leerlos.
- Audio-reactive treatment: sutil — el halo del candado y la presencia del panel
  oscuro respiran con el RMS. Nada de barras, ondas ni partículas.
- Audio-coupled moments:
  - Escena 1, el candado — pestillo seco
  - Escena 6, los tres chips — un sonido de tarjeta por chip, al mismo instante
  - Escena 7, la línea final — un acento contenido
- SFX selection guidance: archivos de riesgo alto-frecuencia BAJO
  (`impact/impactSoft_medium_*`, `casino/card-slide-1`). Nada de whooshes entre cortes.
- SFX analysis guidance: `/home/user/sistemas-maestros/.claude/skills/brag/assets/sfx/sfx-analysis.md`
- Audio files: copiados a `composition/assets/music/` y `composition/assets/sfx/`

## Hyperframes Instructions
Contrato de `hyperframes-core`: raíz standalone (sin `<template>`), `width`/
`height: 100%` con `data-width`/`data-height`, UNA timeline pausada registrada
en `window.__timelines["brag-restaurante"]`, `class="clip"` con `data-start`/
`data-duration`, `@font-face` local para la fuente nombrada, todo `<audio>` con
`id`, sin `crossorigin` en media, sin `<video data-start>` adentro de otro
elemento con `data-start`, y sin tweens de `autoAlpha`/`visibility` sobre un
`.clip`.

Requisitos:
- Mostrar UI real del producto (lo es todo el material: dos capturas y tres clips).
- Todo el texto legible en el render final.
- 15–25s.
- `npx hyperframes check` sin errores antes de renderizar.
