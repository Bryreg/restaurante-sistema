# Hyperframes Composition Brief: Restaurante Sistema

## Objective

Un video corto de lanzamiento para **Restaurante Sistema**, un POS y control
interno para restaurantes colombianos. El video no vende «un POS»: vende la
decisión de diseño que lo distingue — **el cierre de caja se cuenta a ciegas**.

## Output

- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20.4 s

## Source Material

- **Project root:** `/home/user/restaurante-sistema`
- **Primary files read:**
  - `frontend/src/index.css` — la paleta y la tipografía, declaradas como tokens
  - `frontend/src/features/shifts/closeUi.tsx` — `RENGLONES_ESPERADO` y `DesgloseTapado`
  - `frontend/src/features/shifts/CloseWizard.tsx` — el copy del paso tapado y las causas tipadas
  - `backend/app/shifts/service.py` — `compute_breakdown`, la única fórmula
  - `README.md`, `docs/SPEC-NEGOCIO.md`
- **Product name:** Restaurante Sistema
- **Tagline / strongest claim:** «Se cuenta a ciegas, y es a propósito.»
- **Key UI moment to recreate:** el asistente de cierre de turno — el desglose
  **tapado** (cinco renglones con `•••••`) y su apertura en la ecuación completa.

### Copy que debe aparecer textual

Todo esto es copy real del producto, no escrito para el video:

- `Se cuenta a ciegas, y es a propósito`
- `Si la vieras antes, el número que entregás dejaría de ser el que contaste y
  pasaría a ser el que había que dar.`
- Los cinco rótulos del desglose, en este orden y con estos signos:
  `Base del turno` · `Ventas en efectivo (+)` · `Ingresos de caja (+)` ·
  `Egresos de caja (−)` · `Retiros a caja fuerte (−)`
- `Esperado`, `Contado`, `Diferencia`
- Las seis causas tipadas: `Error al dar cambio`, `Gasto sin comprobante`,
  `Propinas mezcladas con la base`, `Venta no registrada`, `Error de conteo`,
  `Sin identificar`
- La nota del turno: `Se dio mal un cambio de 50.000 en la hora pico`

### Cifras (turno 36 de la base generada — reales, no inventadas)

```
Base del turno              $   200.000
Ventas en efectivo        + $ 1.695.000
Ingresos de caja          +         $ 0
Egresos de caja           − $    97.000
Retiros a caja fuerte     − $   950.000
─────────────────────────────────────────
Esperado                    $   848.000
Contado                     $   838.000
Diferencia                  − $   10.000      → Error al dar cambio
```

La ecuación cuadra porque la calculó el backend (`compute_breakdown`), no el
video. **No cambiar ninguna cifra**: si se cambia una, la resta deja de cerrar y
el video pasa a mentir sobre lo único que está afirmando.

Denominaciones del conteo (escena 2), también del turno 36:
`$100.000 × 8`, `$20.000 × 1`, `$10.000 × 1`, `$5.000 × 1`.

## Creative Direction

- **Tone preset:** `polished`
- **Creative direction:** instrumento de precisión, no software alegre
- **Interpretation:** cuatro escenas, sostenidas. Tipografía de peso medio con
  aire. Transiciones suaves. El movimiento sirve a la revelación y nunca la
  adorna. La única energía real del video es el instante en que la ecuación se
  abre — todo lo demás es contención.
- **Angle:** Todo software de caja le muestra al cajero cuánto debería haber
  antes de que cuente. Éste se lo esconde, a propósito, y tiene la razón escrita
  en la propia pantalla. El video es esa asimetría: ocho segundos de `•••••`, y
  después la ecuación entera de una sola vez.
- **Hook:** el desglose tapado sobre el azul de marca — la forma de lo que está
  oculto, sin un solo número.
- **Outro:** `La plata que falta no aparece a fin de mes. Aparece al cerrar el
  turno, con causa y con nombre.`
- **Avoid:**
  - Lenguaje genérico de SaaS
  - Relleno visual abstracto
  - Rediseñar el producto: la paleta y la tipografía son las suyas
  - **Verde o cualquier señal de celebración.** Esto trata de plata que falta.
  - Nombres de personas, correos, PIN, NIT, resoluciones o URLs

## Visual Identity

De `frontend/src/index.css`, valor por valor:

- **Background:** `#EDF1F7`
- **Superficie:** `#FFFFFF`
- **Text:** `#0F1B2D`; secundario `#475569`
- **Accent / marca:** `#1E40AF`; marca suave `#E7EDFB`
- **Estado:** rojo `#B91C1C`, ámbar `#B45309`. **Sólo de estado, nunca visten
  una acción** (`docs/DISENO.md` § La regla del color).
- **Display font y body font:** **Atkinson Hyperlegible** 400/700, servida
  local desde `assets/fonts/atkinson-400.woff2` y `atkinson-700.woff2`. Va con
  `@font-face` en el archivo — un `font-family` con nombre y sin `@font-face`
  local lo rechaza `lint` (`font_family_without_font_face`).
  Elegirla no es estética: el producto la auto-hospeda para que *«el salón no
  dependa de que Google Fonts responda para poder leer precios»*. Usar otra
  sería contradecir al producto en su propio video.
- **Cifras:** `font-variant-numeric: tabular-nums`. Los números de plata no
  bailan al cambiar.

## Storyboard

El contrato creativo es `brag-output/brag-plan.md`. Resumen:

1. **El tapado** — 4.2 s — los cinco renglones con `•••••` sobre el azul, y el
   titular «Se cuenta a ciegas, y es a propósito».
2. **El conteo** — 4.5 s — denominaciones llenándose y un total que crece; el
   esperado sigue tapado.
3. **La ecuación se abre** — 7.1 s — los cinco renglones se destapan uno por
   uno con cifra y signo; después el esperado y el contado. Es la escena más
   larga **a propósito**: es la única que hay que leer renglón por renglón.
4. **La causa, y el nombre** — 4.6 s — la diferencia en rojo, las seis causas
   con una marcada, y el nombre del producto.

## Audio

- **Audio role:** cama baja y sobria, con un solo golpe que importa
- **Audio arc:** ocho segundos casi en silencio mientras el esperado está
  tapado; un golpe limpio cuando la ecuación se abre; acentos medidos sobre los
  renglones y la causa; *fade-out* que deja la última línea sola.
- **Music:** `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- **Music treatment:** entra en 0 s a volumen bajo (≈0.35), sube apenas en el
  destape, *fade-out* en los últimos 1,5 s. Nunca compite con la lectura.
  Implementar el fade con la **lane de automatización de volumen**
  (`data-automation`), no con un tween de `volume` en la timeline: con lane
  presente el tween se ignora.
- **Music cue guidance:** preset bundleado en
  `.claude/skills/brag/assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`
  (110 BPM). Los acentos ya están elegidos contra el storyboard:
  - **8.74 s** (0.985) — **el destape**. Éste es el lock principal.
  - **10.93 / 12.55 / 13.11 / 13.64 s** — rejilla para los renglones del libro.
  - **15.84 s** — la diferencia y la causa.
  - **17.47 s** (0.995) — el nombre del producto.
- **Audio-reactive treatment:** *subtle*. A lo sumo la presencia/elevación de
  la tarjeta del cierre respirando con la energía de la música. **Nada de
  barras de espectro, notas musicales, partículas ni estroboscopía.**
- **Audio-coupled moments:**
  - Escena 2, cada denominación tecleada — tic corto y seco
  - Escena 3, 8.74 s — el golpe del destape
  - Escena 3, renglones — apoyados en la rejilla, sin sonido propio o muy tenue
  - Escena 4, la causa marcada — chasquido corto
- **SFX selection guidance:** que el sonido siga al movimiento real ya
  implementado. Preferir archivos de bajo riesgo de alta frecuencia para lo
  repetido (los ticks del conteo).
- **SFX analysis guidance:** `.claude/skills/brag/assets/sfx/sfx-analysis.md`
  si existe.
- **Exact SFX choice:** la elige Hyperframes después de que exista la animación.
- **Restraint rule:** ningún *whoosh* de plantilla, ninguna campanita de logro,
  ningún *riser*. Si el audio suena a celebración, el video miente sobre lo que
  el producto hace.

## Hyperframes Instructions

Requisitos del contrato:

- Mostrar UI y copy reales del proyecto (ya listados arriba).
- Todo el texto legible en el render final: rótulo corto ≥0.8 s asentado, frase
  ≥0.3 s por palabra. La escena 3 tiene cinco renglones secuenciales — snap a
  la rejilla de beats **sólo si cada renglón conserva su piso de lectura**; si
  no, timing natural y el conjunto sostenido al final.
- 15–25 s totales.
- Capa de música y SFX incluida.
- `npx hyperframes check` sin hallazgos antes de renderizar.

### Notas de implementación que ya sé que aplican acá

Salen de `hyperframes-core`, anotadas para no descubrirlas en el primer `lint`:

- `font-family: 'Atkinson Hyperlegible'` **exige** `@font-face` en el archivo
  apuntando a los woff2 locales de `assets/fonts/`.
- Centrar con flex o `inset`, nunca con `transform: translate(-50%,-50%)` sobre
  un nodo que después se tweenea con `x`/`y` (`gsap_css_transform_conflict`).
- El `<audio>` necesita `id` o el render sale **mudo** (`media_missing_id`), y
  nunca lleva `crossorigin`.
- No tweenear `.clip` con `autoAlpha`/`visibility`: animar un hijo.
- Nada de `<br>` en texto de cuerpo.
- Una sola timeline pausada registrada en `window.__timelines["<id>"]`, con la
  clave igual al `data-composition-id` de la raíz.
- El `#root` va `width/height: 100%`, no `1920px` fijos.
