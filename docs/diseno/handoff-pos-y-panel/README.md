# Handoff: POS de la tablet y panel del dueño (Restaurante Sistema)

## Overview
Rediseño completo del sistema de un restaurante mediano en Colombia, sobre el repositorio `Bryreg/restaurante-sistema` (`frontend/src`, React + Tailwind v4 + shadcn):

- **POS de la tablet** (tanda 1, pantallas 1–7): quién opera, apertura por sobres, mesas + cinta de caja, comanda, cobro, KDS y conteo de apertura.
- **Panel del dueño** (tanda 2, pantallas 8–13): Hoy, ficha de turno, ficha de persona, ficha de insumo, informes, patrón de tabla densa y celular.
- **Vuelta 3**: Caja, Equipo e Informes en el celular. **Se eligió la variante A · tablero** (la B queda en el lienzo como referencia descartada).
- **Lenguaje visual de datos «barra + raya»**, aplicado a todo el panel (ver § Patrón de datos). Es la pieza nueva más importante del handoff.

Todo en español de Colombia; montos con `formatCOP` (`$ 135.000`); modo claro y oscuro.

## About the Design Files
Los archivos `.dc.html` de esta carpeta son **referencias de diseño hechas en HTML**: prototipos que muestran el aspecto y el comportamiento buscados, **no código para copiar**. La tarea es **recrearlos dentro de `frontend/src`** con los patrones que el repo ya tiene: componentes de `components/ui` (shadcn / base-ui), `components/admin` (`PageHeader`, `DenseTable`, `NoticeRail`, `HeadlineFigure`, `StatTile`, `RailItem`), `components/charts`, los tokens de `index.css` y las densidades `.salon` / `.oficina` de `app/density.ts`.

Los prototipos usan estilos en línea y variables CSS con los mismos nombres que `index.css` (`--background`, `--primary`, `--warning`, `--data-1`…). En el repo van como clases Tailwind (`bg-warning/20`, `text-muted-foreground`, etc.). Los íconos son de `lucide` (en el prototipo, con la fuente `lucide-static`); en el repo, `lucide-react`, con los mismos nombres.

Todos los datos son **de ejemplo** y coherentes entre pantallas. En el repo deben venir del backend: el frontend no calcula plata (AGENTS.md, `lib/money.ts`).

## Fidelity
**Alta fidelidad.** Colores, tipografía, tamaños, radios y copy son finales y salen de `index.css`. Hay que recrearlo al píxel con las librerías del repo. Las cifras de umbral son supuestos que el dueño debe confirmar y que deben vivir en Ajustes: margen meta 65 %, mesa larga 60 min, tiquete demorado 20 min, 7 comandas por mesero, retiro a partir de $ 1.200.000.

---

## Design Tokens
Ya existen en `frontend/src/index.css`; no hay tokens nuevos. Resumen de uso:

| Token | Libro claro (`:root`) | Libro noche (`.dark`) | Salón claro (`html.salon`) | Pizarra (`.salon-oscuro`, `.cocina`) |
|---|---|---|---|---|
| background | #F3F5F1 | #101714 | #F7F8F5 | #121A17 |
| foreground | #17231E | #E9EEEA | #101814 | #EEF2EF |
| card | #FFFFFF | #18221D | #FFFFFF | #1B2622 |
| primary (única voz de «actuá acá») | #3D4FE0 | #8D9BFF | #3D4FE0 | #8D9BFF |
| muted / secondary | #E8ECE6 | #202B25 | #E6EBE4 | #26332D |
| muted-foreground | #46544D | #B7C2BC | #3E4B45 | #A9B6AF |
| accent / accent-foreground | #E3E6FB / #2F3DB8 | #232A55 / #C9D0FF | #E3E6FB / #2F3DB8 | #2C3A60 / #D4DAFF |
| success (cuadra) | #0F7A6A | #5CCFB9 | #0F7A6A | #5CCFB9 |
| warning (pendiente / fuera de referencia) | #9A6412 | #F0B458 | #9A6412 | #F0B458 |
| destructive (falta plata / error) | #C4302B | #FF8F88 | #C4302B | #FF8F88 |
| border / input | #D3DAD2 / #BFC8BE | #2A3630 / #3A4841 | #C9D1C8 / #B3BDB2 | #2E3C35 / #3A4841 |
| data-1 (serie) / data-muted | #3a8fc7 / #8C9993 | #3a8fc7 / #7D8A84 | — | — |

- **Tipografía:** Archivo Variable (eje `wdth`: 108 % en títulos y cifras grandes, 72–90 % en tiquetes de cocina) + IBM Plex Mono para PIN, consecutivos y referencias. Toda cifra lleva `tabular-nums`.
- **Salón:** raíz 17 px, radio 12 px, **objetivo táctil mínimo 56 px** (64–72 px en acciones primarias).
- **Oficina:** raíz 16 px, radio 8 px, filas de tabla de 34 px, encabezado de tabla de 30 px.
- **Tiquete KDS:** papel #F2EEE3, tinta #1A1A17, modificador #FFE27A con borde izquierdo de 4 px #C99A00, alergia #FDE3E1 / #7A0F0B con borde de 2 px #C4302B. Son las clases `.tiquete-*` ya existentes.
- **Semáforo por forma:** ● a tiempo / en orden, ▲ atención, ■ demorado / crítico. Son las clases `.semaforo-*` existentes, siempre acompañadas de texto.

---

## Patrón de datos «barra + raya» (nuevo, prioridad alta)
Reemplaza matrices de calor, barras dobles fantasma y tablas largas. **Cada gráfico responde una pregunta escrita como título** (por ejemplo «¿A qué horas falta gente en el salón?»).

**Anatomía**
- **Barra** = el dato. Color `--data-1`, radio de 3 px arriba.
- **Raya** = la referencia (semana anterior, meta, mínimo, umbral, capacidad). Es una línea sólida de 3 px en `--foreground` que sobresale 3–4 px a cada lado de la barra. Horizontal en columnas; vertical en barras horizontales.
- **Barra en ámbar** (`--warning`) cuando queda del lado malo de la raya: la pasa cuando no debe, o no llega cuando debe. Su cifra también va en ámbar, con ▲/▼ y texto. Nunca solo color.
- **Cocina y mesas:** si pasan el límite de tiempo se usa `--destructive`, igual que en el KDS.
- **Lo que viene** (proyección o programado): la misma barra al 35 % de opacidad.
- **«Ahora» o «hoy»:** la barra en `--foreground`, o un anillo de 2 px.
- **Leyenda** arriba, en una fila: cuadro de 12 px por serie y un trazo de 16 × 3 px para la raya, en texto de 12 px `--muted-foreground`.
- **Resumen lateral** de 280 px, separado con `border-left`: rótulo en versalitas de 11 px, luego 2–4 renglones, cada uno con una franja de color de 4 px, título en negrita de 14–15 px y detalle de 13 px. Dice qué pasó y qué hacer.
- La barra enlaza a su detalle. `title` / tooltip lleva la cifra exacta.

**Componente sugerido:** `components/charts/BarrasConReferencia.tsx`, en dos variantes: `columnas` (en el tiempo) y `filas` (categorías). Props aproximadas:

```ts
{
  pregunta: string;
  puntos: {
    etiqueta: string;
    valor: number;
    referencia?: number;
    futuro?: boolean;
    ahora?: boolean;
    href?: string;
  }[];
  referenciaComun?: number;
  malo: "encima" | "debajo";
  tono?: "warning" | "destructive";
  leyenda: { barra: string; raya: string; fuera: string };
  resumen?: { titulo: string; detalle: string; tono: "success" | "warning" | "data" | "muted" }[];
}
```

Construirlo sobre `charts/nucleo.ts` y `ChartFrame` si encaja. Una versión mini («bullet») de 90 × 10 px va dentro de las celdas de tabla y de los bloques de Hoy.

**Dónde se usa**

| Pantalla | Pregunta | Barra | Raya |
|---|---|---|---|
| Informes | ¿Vendí más o menos que la semana pasada? | ventas netas por día (7 columnas) | mismo día de la semana anterior |
| Informes | ¿Qué categoría deja menos plata? | margen por categoría (filas) | meta 65 % |
| Informes | ¿Qué sede va mejor? | ventas netas de la semana por sede (filas) | semana anterior |
| Informes | ¿A qué horas falta gente en el salón? | comandas por hora, 11 a. m.–10 p. m.; selector Promedio / sáb … vie | meseros en turno × 7. Debajo, fila con la cantidad de meseros |
| Hoy · Caja | ventas de hoy / efectivo en caja | bullet | sáb 20 a la misma hora / umbral de retiro |
| Hoy · Quién trabaja | personas en turno por hora | columnas; lo futuro al 35 % | — (se marca «ahora») |
| Hoy · Conteos | avance Cocina / Bar | bullet, ámbar si va atrasado | — |
| Hoy · Salón | minutos de cada mesa abierta | columnas | 60 min |
| Hoy · Cocina | minutos de cada tiquete | columnas; rojo si se pasa | 20 min |
| Ficha de turno | ¿Cuándo hubo más efectivo del que debía? | efectivo por hora, 7 a. m.–10 p. m.; retiros marcados «↓ $ 800.000» | umbral $ 1.200.000 |
| Ficha de insumo | ¿Cuándo se me acaba? | stock al cierre, 14 días + 7 proyectados | mínimo |
| Tabla de inventario, columna Stock | — | bullet 90 × 10 px; tope = mínimo × 2,5 | mínimo |
| Celular · Caja / Equipo / Informes (A) | 4 preguntas por sección | serie de la tarjeta elegida | según la métrica |

**Mix de platos:** mapa de dispersión, con unidades en el eje x y margen en el eje y. Líneas punteadas en los promedios dividen cuatro cuadrantes rotulados: «Venden y dejan», «Dejan, pero venden poco», «Venden, pero dejan poco» y «▲ Revisar» (este en ámbar). Cada punto tiene 14 px, borde del color de la tarjeta, nombre y margen al lado. El resumen lateral dice qué hacer con cada grupo. El repo ya tiene `charts/QuadrantScatter.tsx`: extenderlo.

**Barras de horario (gantt):** una fila de 30 px por persona, en un eje de 6 a. m. a 12 a. m. con marcas cada hora.
- **Ficha de turno:** la barra en `--data-1` va de la entrada a la salida. El relevo es una línea vertical punteada de 2 px.
- **Ficha de persona:** 12 días. El turno programado es un recuadro punteado; el tramo de llegada tarde, un segmento ámbar.

---

## Screens / Views

### POS (tablet)
Las pantallas de caja, comanda, mesas y conteo usan la misma cabecera, `PosBarra`:
- **Fila de 76 px:** avatar de 48 px con iniciales; nombre en 18 px/700 · puesto; contexto en 14 px (sede · día · turno · caja); pastilla opcional con la tarea actual; «Cambiar de persona» (56 px, contorno); menú «⋯» (56 × 56).
- **Barra de secciones por rol:** ítems de 56 px; el activo en `accent` / `accent-foreground` con peso 700.
- Cambia respecto de `PosLayout.tsx`: `ShiftStatusStrip` se integra como subtítulo de la cabecera y se ganan unos 40 px de alto. Cocina no usa esta cabecera: su pantalla tiene barra propia.

1. **Quién opera** (1280 × 800, `PosQuienOpera`): a la izquierda, grilla de 3 columnas con tarjetas de 112 px: círculo de 60 px con iniciales, nombre en 19/700, puesto y estado «Entrada 6:48 a. m.» (verde con ícono) o «Sin entrada hoy». La elegida lleva borde de 3 px `primary`, fondo `accent` y círculo `primary`. Al final, la tarjeta punteada «Otra persona». A la derecha, panel de 440 px: nombre, 4 puntos de 20 px, mensaje de error y teclado de 3 × 96 × 72 px. Con el PIN completo aparece un check de 80 px, «Entrada 7:02 a. m.» y «Ir a {destino del rol}». El menú «⋯» (320 px, filas de 56 px) trae: Entrar como administrador, Marcar salida, Pantalla oscura / Desactivar este dispositivo (atenuado). Reutiliza `PinPad` con teclas más grandes.
2. **Apertura por sobres** (820 × 1180, `PosApertura`): pasos arriba (Elegir sobres ✓ / Contar y sellar / Ver diferencias). Lista de sobres de 64 px con casilla de 32 px, **solo la fecha**, y la pastilla de estado aparece después de sellar («▼ Faltan $ 2.000», «Cuadra · $ 0»). El panel de conteo, con borde de 2 px `primary`, tiene tres columnas: billetes, monedas y un teclado de 3 × 64 px con «Siguiente». Debajo: total contado + «Sellar sobre» (64 px). La tarjeta punteada «Base de respaldo · va aparte y no entra al cuadre» va al final. Es `DenominationKeypad` reordenado; la diferencia se ve solo al sellar.
3. **Mesas + cinta** (`PosMesas`; A vertical 820, B horizontal 1280):
   - **Cinta de una fila:** Domicilios (contador rojo), Cambio, Gasto / Ingreso, botón «del momento» (borde de 2 px ámbar, fondo ámbar al 20 %) y Más, todos de 56 px.
   - **Leyenda con conteos** y el interruptor «Mis mesas».
   - **Tarjetas de 128 px** en `auto-fill minmax(180px, 1fr)`:
     - Libre: `card` con borde `border`.
     - Ocupada: fondo `primary` al 12 % y borde `primary` al 45 %.
     - Por cobrar: fondo `warning` al 22 % y borde `warning`.
     - Contenido: estado con ícono y texto, iniciales en círculo de 34 px, «3 · 12 min», total y los chips «2 listos» (success) y «2 sin enviar» (destructive).
   - La variante B pone las zonas en pestañas.
   - Las acciones abren una **hoja lateral de 480 px** encima de Mesas; el ejemplo es «Cambio», con el cuadre «Entra $ 100.000 · sale $ 100.000 · cuadra».
4. **Comanda** (1280 × 800, `PosComanda`): «← Mesas» y «Mesa 4 · 3 comensales» (28/800), categorías de 56 px y platos en 3 columnas de 92 px. Al tocar un plato se suma al asiento y curso elegidos, con contador en el plato. A la derecha, 470 px: selectores de Asiento (1 · 2 · 3 · Todos) y Curso (Entrada · Fuerte · Postre) de 56 px; líneas «Sin enviar · N» y «Ya en cocina» con chip Listo / En preparación. La línea elegida muestra notas rápidas de 56 px («Sin cebolla», «Aparte», «Término medio»…) en amarillo KDS. Pie fijo: «Pedir cuenta» (solo quien no cobra), total de la mesa, «Enviar y quedarme» y «Enviar a cocina · N ítems» (64 px, `primary`).
5. **Cobro** (1280 × 800, `PosCobro`):
   - **Izquierda, 440 px:** cuenta, con el impuesto al consumo incluido; propina voluntaria en tres opciones de 64 px (10 % sugerida, Otra, Sin propina); libro con doble raya «Propina (no es venta)».
   - **Derecha:** total de 60 px; caja de «Vuelto» o «Falta recibir» (roja). Medios de pago en 5 botones de 64 px: Efectivo, Tarjeta, Nequi, Daviplata, Transferencia. Montos rápidos: Exacto y los billetes siguientes.
   - **Siempre visibles:** «Recibido», el teclado de PIN (3 × 56) y «Cobrar $ X» (72 px), que se habilita solo con pago completo y PIN.
   - **Dividida (B):** Por asiento / Partes iguales / Por plato, con tarjetas por parte (platos, propina prorrateada, medio y estado Pagada / Cobrando / Pendiente).
6. **KDS** (1920 × 1080, siempre pizarra, `PosKds`): barra con estaciones de 56 px (Todas, Caliente, Fría, Postres), conteos ■ ▲ ●, reloj y «Pantalla completa». Tiquetes en 5 columnas, ordenados por demora. La cabecera va pintada según la demora (≥ 20 min #C4302B, ≥ 10 min #9A6412, menos #0F7A6A), con la forma en blanco y mesa y minutos en 27 px con `font-stretch` 72 %. Cada plato lleva «Listo» de 56 px (contorno verde; lleno cuando está listo y tachado). En pantalla completa: 32 px y 24 px.
7. **Conteo de apertura** (820 × 1180, `PosConteo`): pastilla ámbar «Obligatorio para abrir el bar» y barra de progreso. Pestañas Mi área | Bar | Cocina | Todo (56 px, segmentadas) con x/y. Cada artículo es una fila de 64 px con «Contado por Kevin · 7:10» **sin cantidad**, o «Por contar». Al abrir un artículo: Enteras −/+ de 64 px y décimas 0–9 en botones de 64 px con relleno de nivel. «Guardar conteo» y el aviso «Al guardar, la cantidad deja de mostrarse». Pie: «Faltan N» + «Terminar conteo del bar».

### Panel (oficina, 1440 px)
Estructura de `AdminLayout.tsx`: riel de 222 px (identidad + 8 secciones; la activa en `primary` lleno; recuentos al 70 % de opacidad), barra superior de 48 px en `muted` (sede, persona · rol, Avisos con contador, tema, Salir), pestañas de sección de 40 px con subrayado de 2 px `primary`, y `PageHeader` con «¿Qué es esto?» plegable y franja de contexto.

8. **Hoy** (`AdminHoy`):
   - **Semáforo por sede:** 4 tarjetas con borde izquierdo de 4 px y forma. Chapinero ▲ Atención, Usaquén ● En orden, Cedritos ■ Crítico, Salitre gris «Cerrado». Cada una con sus razones.
   - **Variante A:** bloques «Ahora» en 2 columnas (Caja ocupa 2) con barra + raya, y a la derecha «Requiere tu atención», un riel fijo de 420 px al estilo `NoticeRail` con acciones en el mismo lugar:
     - Confirmar consignación / No coincide, con la foto del comprobante ampliable.
     - Cerrar turno abandonado.
     - Aprobar / Rechazar sencillo.
     - Pedir devolución de la base.
     - Revisar novedad.
     - Marcar salida.
   - **Al resolver:** «✓ Confirmada por ti · 12:55 p. m.» + «Reversar con motivo»; nada se borra.
   - **Variante B:** bloques en una franja de 5 y la bandeja a lo ancho.
9. **Ficha de turno** (`AdminFichaTurno`): `HeadlineFigure` (ventas netas + libro + propinas bajo la raya + comparación), «¿Cuadró en cada paso?» (Apertura → Relevo → Cierre, cada uno con esperado, contado y diferencia), «Efectivo en caja» (barra + raya), «Quién trabajó» (gantt con relevo) y **«Ver el detalle del turno»**, plegado, con las 8 tablas `DenseTable`: sobres, retiros, gastos e ingresos, base, relevos, correcciones, conteos por área y asistencia. Las tablas anchas ocupan las 2 columnas y la tabla se desliza de lado antes que recortar.
10. **Ficha de persona / de insumo** (`AdminFicha tipo=persona|insumo`): cabecera con avatar y contexto, 4 `StatTile` con tono.
    - **Persona:** gantt de 12 días.
    - **Insumo:** «¿Cuándo se me acaba?» y «Entradas y salidas por causa» (barras divergentes con `--diverge-falta` y `--data-1`).
    - En ambas, las tablas van detrás de «Ver…» plegable.
11. **Informes** (`AdminInformes`, un solo scroll): selector segmentado «Todas las sedes / Chapinero / …» que recalcula **todo junto** (titular, días, sedes y horas); período «últimos 7 días cerrados», contra la semana anterior. Secciones: Ventas (`HeadlineFigure` + días), Margen, Mix de platos (cuadrante), Horas pico y Por sede, todas con resumen lateral.
12. **Tabla densa** (`AdminTabla`, Inventario › Stock):
    - **Barra de la tabla:** «9 de 47 insumos · …», filtros en píldora y la acción primaria.
    - **Columnas:** 5 principales + «Más columnas (4)».
    - **Ayuda por encabezado:** «?» de 18 px en cada encabezado que la necesita; abre una fila `accent` con la explicación.
    - **Estado de fila:** franja de 3 px, con forma y texto.
    - **Otros:** «Sin costo» rayado (`.sin-dato`), no $ 0; menú «⋯» de 230 px (Ver ficha, Ajustar con motivo, Pedir recuento, Ver libro) con la nota «Nada se borra»; «Cómo leer esta tabla» plegable.
13. **Celular del dueño** (390 × 844, `AdminMovil`, `MovilSecciones`): barra superior de 52 px (☰, sede, «hace 14 s»), barra inferior de 56 px (Hoy · Informes · Caja · Avisos · Más; la activa en `primary` con raya interior de 2 px arriba), objetivos de 44 px mínimo.
    - **Hoy:** semáforo 2 × 2, ventas, bloques y los 3 primeros avisos.
    - **Aviso desde la notificación:** pastilla «Abierto desde una notificación», foto, detalle y acciones fijas sobre la barra.
    - **Caja / Equipo / Informes, variante A (elegida):** 4 tarjetas de 112 px con mini tendencia; la tarjeta elegida, con borde de 2 px `foreground`, abre su detalle debajo (pregunta, cifra de 32 px, gráfico de 120 px con raya, lista de excepciones de 44 px y acción de 48 px).

## Interactions & Behavior
- Después del PIN, cada rol llega directo a su pantalla: caja → Apertura (si no hay apertura) o Mesas; salón → Mesas; cocina y bar → Conteo (si falta) o Tiquetes. El dueño en la tablet solo autoriza.
- El primer PIN del día marca la entrada. Un PIN incorrecto muestra «PIN incorrecto · te quedan N intentos» (el mensaje viene del servidor).
- **A ciegas:** el personal nunca ve el esperado; la diferencia aparece solo después de sellar o cerrar. El dueño ve esperado, contado y diferencia.
- Las acciones de la cinta abren una hoja (`Sheet side="right"`) sobre Mesas, con «← Mesas», y viven en `?accion=` (como hoy en `CashRibbon.tsx`).
- **Cobro:** el vuelto se muestra solo si lo recibido es mayor o igual al total. Con un medio distinto de efectivo, lo recibido es el total y el vuelto dice «No aplica».
- **Resolver un aviso:** es una mutación con PIN o sesión; deja rastro en el historial y ofrece «Reversar con motivo».
- **«Mis mesas»:** muestra las libres y las abiertas por la persona.
- **KDS:** marcar «Listo» pide el PIN rápido de estación (`StationPinDialog`); mirar no lo pide.
- **Celular A:** tocar una tarjeta cambia la métrica del panel de detalle (estado local).

## State Management
- **POS:** persona elegida y PIN; conteo por denominación con denominación activa y «el próximo dígito reemplaza»; sobres elegidos y sellados; líneas de comanda (asiento, curso, notas, enviado); medio, recibido y PIN del cobro; ítem abierto del conteo (enteras, décima).
- **Panel:** sede activa (`storeContext`); día de horas pico; métrica elegida en el celular; plegados de detalle; columnas extra y ayuda abierta en la tabla; avisos resueltos (optimista, con reversa).
- **Datos:** las series de barra + raya necesitan endpoints que den valor **y** referencia ya calculados (ventas por día con el mismo día anterior, efectivo por hora con el umbral, comandas por hora con meseros en turno, stock diario con mínimo y proyección). Recomendado: extender `api/reports.ts` y `api/panel.ts` en vez de calcular en el cliente.

## Assets
Sin imágenes propias. Íconos de lucide. Las fotos de comprobantes son marcadores rayados con el rótulo «foto del comprobante · Bancolombia»; en el repo, `PhotoCaptureField` y la foto real.

## Files
Abrir con `support.js` en la misma carpeta. Los lienzos llevan los tokens como variables en cada tablero; las pantallas sueltas, sin lienzo, salen sin color.

| Archivo | Qué es | Archivos del repo relacionados |
|---|---|---|
| `POS.dc.html` | Lienzo tanda 1 (1a–1q) | `app/PosLayout.tsx`, `app/theme.tsx` |
| `PosBarra.dc.html` | Cabecera y barra del salón | `app/PosLayout.tsx`, `features/shifts/ShiftStatusStrip.tsx` |
| `PosQuienOpera.dc.html` | 1 · Quién opera | `components/PinPad.tsx`, `app/puesto.ts` |
| `PosApertura.dc.html` | 2 · Apertura por sobres | `components/DenominationKeypad.tsx`, `features/shifts/EnvelopeOpeningForm.tsx` |
| `PosMesas.dc.html` | 3 · Mesas + cinta + hoja | `features/orders/TablesPage.tsx`, `features/shifts/CashRibbon.tsx`, `CashSwapPanel.tsx` |
| `PosComanda.dc.html` | 4 · Comanda | `features/orders/OrderPage.tsx`, `CatalogPanel.tsx`, `OrderItemsList.tsx` |
| `PosCobro.dc.html` | 5 · Cobro (entera / dividida) | `features/payments/CheckoutPage.tsx`, `SplitBillPanel.tsx`, `TipQuestion.tsx` |
| `PosKds.dc.html` | 6 · KDS | `features/kitchen/KdsPage.tsx`, `.tiquete*` en `index.css` |
| `PosConteo.dc.html` | 7 · Conteo de apertura | `features/inventory/AreaCountPanel.tsx`, `OpeningCountGate.tsx` |
| `Panel.dc.html` | Lienzo del panel: vuelta 3 (3a–3l) y tanda 2 (2a–2r) | `app/AdminLayout.tsx` |
| `AdminRail.dc.html`, `AdminTop.dc.html` | Riel, barra superior y pestañas | `app/AdminLayout.tsx`, `components/admin/RailItem.tsx` |
| `AdminHoy.dc.html` | 8 · Hoy (A / B) | `features/reports/TodayPage.tsx`, `PanelAhora.tsx`, `components/admin/NoticeRail.tsx` |
| `AdminFichaTurno.dc.html` | 9 · Ficha de turno | `features/reports/fichas/FichaTurno.tsx`, `components/admin/HeadlineFigure.tsx` |
| `AdminFicha.dc.html` | 10 · Ficha de persona / insumo | `fichas/FichaPersona.tsx`, `fichas/FichaInsumo.tsx` |
| `AdminInformes.dc.html` | 11 · Informes | `features/reports/InformesPage.tsx`, `components/charts/*` |
| `AdminTabla.dc.html` | 12 · Tabla densa | `components/admin/DenseTable.tsx`, `features/inventory/StockTab.tsx` |
| `AdminMovil.dc.html` | 13 · Hoy y aviso en el celular | `AdminLayout.tsx` (`BarraInferior`), `features/notifications/*` |
| `MovilSecciones.dc.html` | Caja / Equipo / Informes en el celular (usar `variante="A"`) | nuevas pantallas móviles de Caja, Equipo e Informes |

## Capturas
En `capturas/`, una por pantalla y, salvo que se indique, en claro. `09-ficha-turno.png` y `13a-movil-hoy.png` están en noche; `09-ficha-turno-claro.png` es la versión clara. KDS, fichas y ficha de turno van a 0,5×. Sirven de referencia rápida; la fuente de verdad son los `.dc.html`.

## Orden sugerido de implementación
1. `BarrasConReferencia` (columnas, filas, bullet) y el gantt de horario en `components/charts`, con tests.
2. Panel: Informes → Hoy → Ficha de turno → Fichas → celda de stock en `DenseTable`.
3. Celular A de Caja, Equipo e Informes.
4. POS: cabecera unificada → Mesas / cinta → Cobro → Comanda → Apertura → Conteo → Quién opera → KDS.
