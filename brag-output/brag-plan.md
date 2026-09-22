# Brag Plan: Restaurante Sistema

## What is this app?

Un POS y panel de control interno para restaurantes colombianos donde **toda la
matemática del dinero vive en el backend** y el cierre de caja se cuenta **a
ciegas**: el cajero entrega el conteo antes de que el sistema le diga cuánto
debería haber.

## The angle

No es «otro POS». Un POS cobra; esto **audita al que cobra**, y lo hace con una
decisión de diseño que se puede mostrar en pantalla en dos segundos: el
desglose del cajón aparece tapado, renglón por renglón, con `•••••` donde van
las cifras.

La premisa del video es esa asimetría. Todo software de caja te muestra el
esperado. Éste te lo esconde, a propósito, y tiene escrita la razón en la
propia pantalla:

> **«Si la vieras antes, el número que entregás dejaría de ser el que contaste
> y pasaría a ser el que había que dar.»**

Esa frase es copy real del producto (`frontend/src/features/shifts/CloseWizard.tsx`),
no un eslogan escrito para el video. Es el video entero.

## Hook (first 2-3 seconds)

El **desglose tapado** sobre el azul de marca: cinco renglones —Base del turno,
Ventas en efectivo, Ingresos de caja, Egresos de caja, Retiros a caja fuerte—
cada uno con `•••••` en lugar de su cifra, y una pastilla con candado que dice
`Paso 2 · tapado`.

Se ve **la forma de lo que está oculto sin ver un solo número**. Eso genera la
pregunta que sostiene los otros dieciocho segundos: *¿por qué me lo tapan?*

## Key moments (the middle)

- **El conteo a ciegas.** Denominaciones colombianas llenándose —$50.000 ×N,
  $20.000 ×N, $10.000 ×N— y un total que crece. El esperado sigue tapado. Que
  se sienta que la persona está entregando un número sin red.
- **La ecuación se abre de golpe.** Los cinco renglones se destapan **uno por
  uno** con su cifra y su signo, y abajo aparece el esperado. Una sola
  matemática, calculada en el servidor: la pantalla no la recalcula.
- **La diferencia y su causa tipada.** La diferencia aparece en rojo, y debajo
  las seis causas que el sistema obliga a elegir —Error al dar cambio, Gasto
  sin comprobante, Propinas mezcladas con la base, Venta no registrada, Error
  de conteo, Sin identificar—. Una se marca. **La diferencia nunca bloquea el
  cierre**: bloquear dejaría el turno abierto y vendiendo.

## Outro / punchline

El nombre del producto sobre el fondo claro, y una línea que cierra el
argumento del hook. La plata que falta no se descubre al final del mes: se
descubre al final del turno, con nombre y causa.

## User flow worth showing

Los tres pasos reales de cerrar caja, que son el corazón del producto:

1. **Entrada** — el cajero abre el cierre y ve el desglose tapado.
2. **Acción** — cuenta por denominaciones y entrega el conteo sin ver el esperado.
3. **Resultado** — el servidor abre la ecuación, revela la diferencia y exige
   una causa tipada para poder cerrar.

Este flujo es el centro del video. Los seis meses de operación sólo dan el
contexto de la última escena.

## Tone

- **Preset:** `polished`
- **Creative direction:** instrumento de precisión, no software alegre — un
  producto sobre plata que falta se presenta serio
- **Interpretation:** pocas escenas, sostenidas y largas; tipografía de peso
  medio y buen aire; transiciones suaves; el movimiento sirve a la revelación
  y nunca la adorna. La única energía real del video es el instante en que la
  ecuación se abre.

## Format: landscape — 1920x1080
## Duration: 20.4 s

## Visual identity (from the project)

Tomada literalmente de `frontend/src/index.css`, que a su vez la declara
derivada de la maqueta `m2b`:

- **Background:** `#EDF1F7` (`--background`, oklch 0.9568 0.0091 258.34)
- **Superficie / tarjeta:** `#FFFFFF` (`--card`)
- **Accent / marca:** `#1E40AF` (`--primary`) — azul profundo
- **Marca suave:** `#E7EDFB` (`--accent`)
- **Text:** `#0F1B2D` (`--foreground`), secundario `#475569` (`--muted-foreground`)
- **Estado:** rojo `#B91C1C` (`--destructive`), verde `#15803D` (`--success`),
  ámbar `#B45309` (`--warning`). **Sólo de estado: nunca visten una acción**
  (`docs/DISENO.md` § La regla del color) — respetarlo en el video.
- **Display font y body font:** **Atkinson Hyperlegible** (400 y 700), la misma
  para ambos. Está auto-hospedada a propósito: *«el salón no depende de que
  Google Fonts responda para poder leer precios»*. Es una fuente diseñada para
  legibilidad, y eso **es** el argumento del producto — vale usarla de verdad,
  no una sustituta.
- **Cifras:** tabulares (`tabular-nums`). Los números de plata no bailan al
  cambiar.
- **Strongest visual element:** el desglose tapado (`DesgloseTapado` en
  `frontend/src/features/shifts/closeUi.tsx`) — cinco renglones con `•••••`
  sobre el azul de marca.

## Share copy (draft)

Construí un POS que le esconde al cajero cuánta plata debería haber en el
cajón. A propósito: si la ve antes de contar, el número que entrega deja de ser
el que contó.

## Audio direction

- **Role:** cama baja y sobria, con un solo golpe que importa
- **Music:** `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- **Por qué ésta y no otra:** es la más lenta de las cinco (110 BPM) y **su
  primer acento fuerte cae recién a los 8,74 s**. Los primeros ocho segundos
  son tranquilos, que es exactamente lo que dura el tapado. La música sube
  cuando la ecuación se abre, no antes.
- **Music treatment:** entra desde 0 s a volumen bajo, sube ligeramente en el
  destape, y baja con *fade-out* en los últimos 1,5 s. Nunca compite con la
  lectura.
- **Music cue guidance:** preset leído de
  `assets/music/cues/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`
  (110 BPM). Acentos fuertes a apuntar:
  - **8,74 s** (intensidad 0,985) — **el destape de la ecuación**. Es el golpe
    del video.
  - **10,93 / 12,55 / 13,11 / 13,64 s** — ventana de rejilla para los renglones
    del libro cayendo uno por uno.
  - **15,84 s** — la diferencia y su causa.
  - **17,47 s** (0,995, el más fuerte del tramo) — el nombre del producto.
- **Audio-reactive treatment:** *subtle*. A lo sumo, que la presencia de la
  tarjeta del cierre respire con la energía de la música. **Nada de barras de
  espectro, notas musicales ni partículas.**
- **SFX posture:** *sparse*. Tres momentos, no más: el tic de cada
  denominación al teclearse, un golpe seco y limpio en el destape, y un chasquido
  corto al marcar la causa.
- **Audio-coupled moments:** el conteo por denominaciones (ticks), el destape
  (golpe en 8,74), los cinco renglones (rejilla de beats), la causa marcada.
- **Restraint rule:** ningún *whoosh* de plantilla, ninguna campanita de
  logro, ningún *riser* creciente. Esto trata de plata que falta: si el audio
  suena a celebración, el video miente.

## Storyboard

### Scene 1 — El tapado — 4.2s

Fondo `#1E40AF`. En el centro, la tarjeta del cierre con la pastilla
`🔒 Paso 2 · tapado` arriba y, debajo, los cinco renglones del desglose, cada
uno con su rótulo real a la izquierda y `•••••` a la derecha:

```
Base del turno            •••••
Ventas en efectivo        •••••
Ingresos de caja          •••••
Egresos de caja           •••••
Retiros a caja fuerte     •••••
```

Sobre ellos, el titular real de la pantalla: **«Se cuenta a ciegas, y es a
propósito»**. Entra rápido (0,4 s) y **se sostiene**.

Sequential/interaction: sí — los cinco renglones aparecen uno por uno, rápido
(≈0,25 s entre cada uno), y el conjunto completo se sostiene ≥2 s después del
último. No son texto que haya que leer con cuidado: son forma.
Audio intent: silencio casi total, tensión contenida. La música apenas se
insinúa.
Audio-coupled idea: ninguno más allá de la aparición de los renglones.
Music: entra a volumen bajo desde 0 s (tramo tranquilo del track).
Transition mood: soft → Scene 2

### Scene 2 — El conteo — 4.5s

Corte suave al fondo claro `#EDF1F7`. Tarjeta blanca: el formulario de conteo
por denominaciones. Se llenan de arriba abajo, con cifras tabulares:

```
$100.000  ×  8      $ 800.000
$ 20.000  ×  1      $  20.000
$ 10.000  ×  1      $  10.000
$  5.000  ×  1      $   5.000
```

y un **total contado** creciendo abajo. A un costado, tenue, la pastilla del
paso sigue diciendo que el esperado está tapado.

Sequential/interaction: sí — se simula el tecleo: cada cantidad aparece y el
total se recalcula. Cuatro denominaciones, ≈0,8 s cada una.
Audio intent: trabajo, foco, ningún dramatismo. Ticks secos y bajos.
Audio-coupled idea: un tic corto por cada cantidad tecleada; el total tiene un
tic apenas distinto.
Music: sigue baja; el track todavía está en su tramo tranquilo.
Transition mood: soft, pero acelerando hacia el corte → Scene 3

### Scene 3 — La ecuación se abre — 7.1s

**El golpe cae en 8,74 s.** Los `•••••` se convierten en cifras. Los cinco
renglones se destapan uno por uno sobre la rejilla de beats (10,93 / 12,55 /
13,11 / 13,64), cada uno con su signo:

```
Base del turno                $ 200.000
Ventas en efectivo        + $ 1.695.000
Ingresos de caja          +         $ 0
Egresos de caja           −    $ 97.000
Retiros a caja fuerte     −   $ 950.000
──────────────────────────────────────────
Esperado                      $ 848.000
```

Debajo, en el mismo peso: **Contado $ 838.000**.

Esta escena es más larga que las otras **a propósito**: es la única del video
que el espectador tiene que leer renglón por renglón, y cada uno necesita su
tiempo asentado. Acortarla sería romper la ley de legibilidad para ganar un
segundo que no hace falta.

Sequential/interaction: sí — cinco renglones uno por uno, cada uno ≥0,8 s
asentado, y el total se traza al final. El conjunto completo queda en pantalla
≥1,2 s antes del corte.
Audio intent: alivio y revelación. El golpe seco en el destape, después nada
que estorbe la lectura.
Audio-coupled idea: un golpe limpio en 8,74; los renglones apoyados en la
rejilla, sin sonido propio salvo un tic muy tenue.
Music: sube al tramo con acentos. Éste es su momento.
Transition mood: clean → Scene 4

### Scene 4 — La causa, y el nombre — 4.6s

La diferencia aparece en `#B91C1C`: **− $ 10.000**. Debajo, las seis causas
tipadas en fila, y una se marca (15,84 s):

```
[ Error al dar cambio ✓ ] · Gasto sin comprobante · Propinas mezcladas con la base
Venta no registrada · Error de conteo · Sin identificar
```

Y, breve, la nota que el cajero escribió — que también es real:
**«Se dio mal un cambio de 50.000 en la hora pico»**. Es la prueba de que la
causa tipada no es un menú decorativo: obliga a nombrar qué pasó.

Una línea corta, del producto: **la diferencia nunca bloquea el cierre**.

En 17,47 s —el acento más fuerte del tramo— todo se retira y queda el nombre
sobre el fondo claro: **Restaurante Sistema**, y bajo él la línea de cierre:

> La plata que falta no aparece a fin de mes. Aparece al cerrar el turno, con
> causa y con nombre.

Sequential/interaction: sí — las seis causas aparecen como conjunto (no una por
una: son opciones, no una lista para leer), y **una** se marca con un
movimiento breve.
Audio intent: resolución sobria. Un chasquido corto al marcar la causa; el
acento de 17,47 lleva el nombre; después, *fade-out*.
Audio-coupled idea: chasquido en la causa marcada; el nombre entra con el
acento.
Music: último tramo, con *fade-out* en los 1,5 s finales.
Transition mood: —

**Music mood for this video:** sobrio y contenido, con un único momento de
energía en el destape (no «upbeat»).
**Audio summary:** ocho segundos casi en silencio mientras el esperado está
tapado, un golpe limpio cuando la ecuación se abre, acentos medidos sobre los
renglones y la causa, y un *fade-out* que deja la última línea sola.

---

## Notas de material y de seguridad

**Las cifras de las escenas 2, 3 y 4 son del turno 36 de la base generada**, no
inventadas para el video. Los seis meses se cargaron con `app.demo_operacion`,
que escribe pasando por los servicios reales del backend, así que la ecuación
que se ve en pantalla cuadra porque la calculó `compute_breakdown`:

```
200.000 + 1.695.000 + 0 − 97.000 − 950.000 = 848.000   ← esperado
838.000 − 848.000 = −10.000                            ← diferencia
```

Verificado contra la fila guardada: `expected_cash = 848000`,
`difference = -10000`, `close_cause = change_error`. El desglose de
denominaciones de la escena 2 y la nota de la escena 4 también salen de ese
turno.

**Nada de identidad en pantalla.** El video no muestra nombres de personas,
correos, PIN, NIT, resoluciones, URLs internas ni credenciales. Los nombres del
personal de la base son inventados, pero un nombre completo pegado a una
diferencia de caja se lee como una acusación aunque la persona no exista: en el
video se usan rótulos de rol, o nada. El repositorio es público y tiene PIN de
demostración en `backend/app/seed.py` — **ninguno de esos valores entra al
video**.
