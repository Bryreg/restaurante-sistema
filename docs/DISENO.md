# DISENO.md — el sistema visual

La dirección sale de la maqueta `m2b` (Mesas, Comanda, Cobro, Documento, Cierre
de caja, Analítica). Acá está traducida a tokens. Todo vive en
**`frontend/src/index.css`**; ninguna pantalla define color por su cuenta.

## La paleta

Un solo sistema para las 36 pantallas. Los nombres son los de shadcn —956 clases
semánticas dependían de ellos—; cambiaron los valores. Cada token anota en el
CSS de qué color de m2b sale.

| Token | De m2b | Qué es |
|---|---|---|
| `background` | `--bg` `#EDF1F7` | El lienzo. Azulado, no blanco: las tarjetas se levantan contra él. |
| `card` / `popover` | `--surface` blanco | El papel. Todo lo que contiene datos. |
| `muted` / `secondary` | `--surface-2` | Zona quieta: cabecera de tabla, subtotal, reposo. |
| `foreground` | `--ink` `#0F1B2D` | Tinta principal. |
| `muted-foreground` | `--ink-2` `#475569` | Tinta secundaria. `--ink-2` y no `--ink-3`: 7,6:1 contra el papel en vez de 4,8:1, y esto se mira ocho horas. |
| `primary` / `ring` | `--brand` `#1E40AF` | **El único color de acción**: botón, enlace, foco. |
| `accent` | `--brand-soft` | Lo elegido: fila activa, navegación actual, renglón recién agregado. |
| `border` / `input` | `--line` / `--line-2` | Separa / borde de control: el segundo se ve más porque es tocable. |
| `success` `warning` `destructive` | `--ok` `--warn` `--bad` | Los tres estados. |
| `chart-1…5` | derivados de `--brand` | Rampa de azul a pizarra. |

El oscuro no está en m2b: se derivó del único oscuro que la maqueta sí define
—el bisel de la tablet y el panel del sello—. La marca y los tres estados suben
en luminosidad para sostener AA sobre fondo oscuro.

## La regla del color

**Verde, ámbar y rojo son de estado. Nunca de acción.**

Dicen cómo está algo: a tiempo, por vencer, demorado; cuadra, sobra, falta. No
visten un botón. Un «Confirmar» verde le enseña al operador que el verde quiere
decir «tocá acá», y el día que aparezca para decir «el turno cuadró» no lo va a
leer. **Lo que se toca es azul.** Al revés también: un número en azul no está
bien ni mal. Por eso `chart-1…5` es una rampa azul: una serie verde le robaría
el significado al verde.

## Las dos densidades

Mismo color, otra escala. La clase la pone `src/app/density.ts` en `<html>`.

- **`.salon`** (`PosLayout`) — tablet compartida, de pie, kiosko. Cuerpo 17 px,
  objetivo táctil mínimo 52 px, radio 12 px.
- **`.oficina`** (`AdminLayout`) — PC del administrador, sentado, con mouse.
  Cuerpo 14,5 px, control de 34 px, radio 8 px.

La escala se mueve desde el tamaño de letra de la raíz: las utilidades de
Tailwind están en `rem`, así que una variable mueve texto y espaciado juntos. Va
en `<html>` y no en el `<div>` del layout por dos razones: `rem` se mide contra
la raíz, y los diálogos se montan por portal fuera del layout —desde el `<div>`,
el que confirma un cobro se dibujaría con la escala del escritorio.

`--control-min-h` es un **mínimo**, aplicado en `Button`. Nunca achica un botón
que ya pidió ser más alto: los `h-11` escritos a mano en el salón siguen
valiendo y quedan como red de seguridad. `xs`/`sm`/`icon-xs`/`icon-sm` quedan
afuera a propósito: son el botón chico deliberado de la maqueta (`.btn-chico`),
el de adentro de una fila de tabla.

## La tipografía

**Atkinson Hyperlegible**, auto-hospedada (`@fontsource/atkinson-hyperlegible`,
400 y 700). La hizo el Braille Institute para baja visión: distingue las formas
que se confunden —`1`/`l`/`I`, `0`/`O`, `6`/`b`—, justo lo que se paga caro
contando un cajón o tecleando un consecutivo. El respaldo (Verdana, DejaVu Sans)
es el de m2b: si no carga, la pantalla se corre poco.

Va por paquete y **no** por el CDN de Google Fonts: esto se sirve en producción y
el salón no puede depender de una red externa para leer precios. Las cifras
dentro de `<table>` salen con `tabular-nums`: una columna de plata no salta.

## Lo que no se hace

- **No escribas un color de Tailwind a mano** (`bg-amber-500`, `text-red-600`, un
  hex). Si te falta un color, falta un token: agregalo acá. Hoy quedan cero:
  ```bash
  grep -rnE '\b[a-z-]+-(red|amber|green|emerald|blue|slate|gray|zinc|neutral)-[0-9]{2,3}\b' --include=*.tsx --include=*.ts src/
  ```
  Buscá también en `.ts`: el semáforo de cocina vivía ahí y se escapaba de un
  grep que sólo miraba `.tsx`.
- **No uses un estado para una acción**, ni la marca para un estado.
- **No pongas `dark:` con un color crudo**: el token ya cambia solo.
- **No cambies el alto de un control con un número suelto** si lo que buscás es
  densidad: eso es `--control-min-h`.
