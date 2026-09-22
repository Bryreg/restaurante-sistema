# Brag Plan: Restaurante Sistema

## What is this app?
Un POS + control interno multi-sede para restaurantes colombianos: el mesero toma
el pedido en la tablet del salón y el dueño ve, esa misma noche, cuánto debería
haber en cada cajón, cuánto había de verdad y quién respondió por la diferencia.

## The angle
**No es «otro POS».** Un POS cualquiera te dice cuánto vendiste. Éste te dice
cuánto falta y por qué — y está construido para que nadie, ni siquiera el
software, pueda maquillar esa respuesta.

La prueba está en una pantalla que **esconde información a propósito**: el
cierre de caja a ciegas. Hasta que el cajero no confirma lo que contó, el
sistema no le muestra cuánto debería haber. Es un producto que renuncia a la
comodidad para que el número signifique algo. Eso es lo que ningún competidor
pone en una demo, porque a primera vista parece un defecto.

## Hook (first 2-3 seconds)
El panel oscuro del cierre, con su candado, y **la copia real del producto**:

> «Se cuenta a ciegas, y es a propósito.»

Nada de motion graphics. La primera imagen es la pantalla de verdad, y la
primera frase es la que ya está escrita adentro del sistema.

## Key moments (the middle)
- **Los cinco renglones tapados.** Base del turno, ventas en efectivo, ingresos,
  egresos, esperado en el cajón — los cinco en `•••••`. Una UI que se niega a
  contestar hasta que vos contestes primero.
- **El turno funcionando, en video real**: el salón con doce mesas (una en
  «pidió cuenta», una apartada), marchar a cocina, y el documento equivalente
  POS con el impuesto discriminado.
- **La prueba a fin de mes**: 84 turnos cerrados con su esperado, su contado y
  su diferencia — `+$42.000`, `−$14.000`, `−$4.500` — cada una esperando una
  causa tipada.

## Outro / punchline
> «El control de la plata. No sólo la venta.»

## User flow worth showing
Dos flujos, y el segundo es el que nadie muestra:

1. **El salón** — mesa ocupada → marchar a cocina → cobrar → documento
   equivalente POS. (Clips reales: `p2-salon`, `p6-cocina`, `p10-documento`.)
2. **El cierre a ciegas** — contar el cajón sin ver el esperado → confirmar →
   recién ahí se abre la ecuación → la diferencia pide una causa.
   (Captura real: pantalla de Cierre, paso 1 de 3.)

El centro del video es el 2: es el argumento.

## Tone
- Preset: `polished`
- Creative direction: una película corta y sobria sobre plata que no se deja maquillar
- Interpretación: pocas escenas, planos largos, tipografía grande y quieta. La
  energía viene de lo que dice la pantalla, no del movimiento. Cero efectos que
  no existan en el producto.

## Format: landscape — 1920x1080
## Duration: 20.5s

## Visual identity (from the project)
- Background: `#EDF1F7` (`--background`, m2b `--bg`)
- Superficie: `#FFFFFF` · Panel oscuro del sello: `#17202B`, bisel `#26303F`
- Accent / marca: `#1E40AF` (`--primary`, m2b `--brand`) · suave `#E7EDFB`
- Text: `#0F1B2D` (`--foreground`, m2b `--ink`) · secundaria `#475569`
- Diferencia en rojo: `#B91C1C` · ámbar de aviso: `#B45309`
- Display font: Atkinson Hyperlegible 700 (la del producto, elegida por legibilidad)
- Body font: Atkinson Hyperlegible 400
- Strongest visual element: el panel «LO QUE EL SISTEMA ESPERA» con el candado y
  los cinco renglones en `•••••`

## Datos en pantalla
Toda la data es **de demostración, generada** (seis semanas de operación
simulada). Los nombres —Yuliana Restrepo, Édison Cardona, Katherine Arango— y
las direcciones son ficticios y salen del generador, no de clientes reales.
Ningún dato personal, token, host interno ni credencial entra en el video.

## Share copy (draft)
Construí un POS para restaurantes que esconde el número a propósito: hasta que
el cajero no confirma lo que contó, no ve cuánto debería haber. Porque un
esperado que se ve antes deja de ser un conteo y pasa a ser una instrucción.

## Audio direction
- Role: warm bed con acentos escasos y profesionales
- Music: `happy-beats-business-moves-vol-9-by-ende-dot-app.mp3` (114.84 BPM)
- Music treatment: entra con fade de 0→1.2s, volumen sostenido y discreto
  (≈0.55), y baja con fade en los últimos 1.4s bajo la línea final.
- Music cue guidance: preset leído de
  `assets/music/cues/happy-beats-business-moves-vol-9-by-ende-dot-app.music-cues.json`.
  Strong cues en ventana: 3.70 · 4.23 · 6.34 · 10.54 · 12.65.
  **Lock principal: el corte del hook a las 3.70s** (strong, 0.99).
  Rejilla de beats ≈0.526s; para los tres chips de diferencia usar **beats
  alternos** (≈1.05s entre uno y otro), que es lo que deja leerlos.
- Audio-reactive treatment: sutil. El halo del candado y la presencia del panel
  oscuro respiran con el RMS. Nada de barras, ondas ni partículas.
- SFX posture: escasos. Un pestillo seco en el candado, un sonido de tarjeta por
  cada chip de diferencia, un acento contenido en la línea final.
- Audio-coupled moments: el cierre del candado; los tres chips de diferencia que
  entran uno por uno; el remate.
- Restraint rule: el audio **no** subraya cada corte. Si el plano ya se explica
  solo, va mudo. Nada de whooshes entre escenas.

## Storyboard

### Scene 1 — Se cuenta a ciegas — 3.70s
La captura real de Cierre (paso 1 de 3), encuadrada sobre el panel oscuro de la
derecha. Empuje lento (scale 1.00 → 1.04). El candado tiene un halo tenue que
respira con la música. Sobre el panel, en tipografía grande:
**«Se cuenta a ciegas, y es a propósito.»** (entra a 0.70s, queda quieta 2.4s).
Sequential/interaction: none.
Audio intent: entrar en serio, sin fanfarria. Un pestillo seco cuando aparece el candado.
Audio-coupled idea: pestillo en el candado ≈0.55s.
Music: bed cálido entrando desde silencio.
Transition mood: clean (corte seco en el strong cue 3.70) → Scene 2

### Scene 2 — Por qué — 3.70s
Sigue el mismo panel, ahora con los cinco renglones `•••••` legibles y el resto
de la pantalla atenuado. Texto:
**«Si lo vieras antes, dejaría de ser el número que contaste.»**
(entra a 3.95s, queda quieta hasta 7.40 → 3.15s de lectura para 10 palabras).
Sequential/interaction: los cinco renglones tapados se marcan uno tras otro con
un resalte suave (no texto nuevo: sólo el subrayado corriendo por los cinco).
Audio intent: sostener. Sin acento nuevo.
Audio-coupled idea: none (el plano ya pesa).
Transition mood: clean → Scene 3

### Scene 3 — El salón, en vivo — 2.00s
Clip real `p2-salon.mp4`: doce mesas, una ámbar en «Pidió cuenta», una apartada
a nombre de una familia, la barra con dos puestos, el riel con para llevar,
domicilios y plataformas. Cinta chica abajo: **«El salón, en vivo»**.
Sequential/interaction: none (la pantalla ya está llena de estado real).
Audio intent: el bed se abre un poco; la música lleva el ritmo.
Transition mood: clean → Scene 4

### Scene 4 — Marchar a cocina — 2.20s
Clip real `p6-cocina.mp4`. Cinta: **«Cocina lo ve al instante»**.
Sequential/interaction: none.
Audio intent: continuidad.
Transition mood: clean → Scene 5

### Scene 5 — El documento — 2.60s
Clip real `p10-documento.mp4`. Cinta:
**«Documento equivalente POS · impuesto discriminado, no sumado»**.
Sequential/interaction: none.
Audio intent: continuidad.
Transition mood: clean → Scene 6

### Scene 6 — Y a fin de mes — 3.71s
Captura real de Dinero → Historial: 84 turnos con esperado, contado y
diferencia. Empuje lento. Tres chips entran **uno por uno** sobre la columna de
diferencia: `+$42.000`, `−$14.000`, `−$4.500`, a 14.76 / 15.81 / 16.86
(beats alternos, 1.05s entre uno y otro). Línea sobreimpresa:
**«84 turnos. Cada diferencia, con su causa.»**
Sequential/interaction: sí — los tres chips, uno por uno.
Audio intent: tres acentos secos de tarjeta, uno por chip.
Audio-coupled idea: card sound en cada chip, al mismo instante que el visual.
Transition mood: soft → Scene 7

### Scene 7 — Remate — 2.63s
Fondo `#EDF1F7`. Marca **Restaurante Sistema** y debajo, quieta:
**«El control de la plata. No sólo la venta.»**
Sequential/interaction: none.
Audio intent: un acento contenido al aterrizar la línea; la música baja con fade.
Music: fade out en los últimos 1.4s.

**Music mood for this video:** sobrio y cálido, nunca festivo.
**Audio summary:** entra desde el silencio con un pestillo, sostiene sin
subrayar los cortes, marca tres acentos secos en las diferencias y se retira
bajo la línea final.
