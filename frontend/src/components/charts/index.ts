/**
 * Sistema de gráficos compartido: SVG/HTML + CSS propios, sin librería
 * (SPEC-NEGOCIO §9.3). Todo gráfico va adentro de un `ChartFrame`, que pone
 * el titular (la CONCLUSIÓN, no el nombre del gráfico), la base (n y
 * ventana, con la marca de «muestra chica») y la tabla gemela que se alterna
 * con «Ver tabla»/«Ver gráfico».
 *
 * QUÉ FORMA PARA QUÉ (informe de visualización, § d):
 *
 * 1. Una cifra sola, con su comparación → no es un gráfico: `StatTile` /
 *    `HeadlineFigure` (`@/components`). Un avance hacia una meta (punto de
 *    equilibrio) → `Medidor`.
 * 2. Magnitud por categoría:
 *    · ORDINAL (hora, día de la semana, orden propio) → `ColumnChart`, con
 *      `serieReferencia` para «mismo día de la semana pasada».
 *    · NOMINAL (canal, persona, plato, medio) → `BarList`, ordenada por
 *      valor, top 7 y «y N más» a la tabla (nunca un «Otros» sumado acá).
 * 3. Tendencia en el tiempo (días, turnos) → `TrendLine`: eje de fechas
 *    cortas (`formatFechaCorta`), ticks redondos, marcador en el último punto.
 * 4. Composición / participación (medio de pago, canal) → `Stacked100`.
 *    Nunca torta.
 * 5. Diferencias con signo (caja, varianza) → `DivergingBars`: cero al
 *    centro, faltante rojo, sobrante ámbar, siempre ▼/▲ y la cifra con signo.
 * 6. Concentración (varianza por insumo) → `Pareto`: barras más la línea de
 *    acumulado como marca 0–100 % con la guía del 80 %.
 * 7. Dos medidas por elemento con umbrales (ingeniería de menú) →
 *    `QuadrantScatter`, una sola tinta. Una serie en el tiempo contra una
 *    regla (salud sostenida por ventana) → `ThresholdDots`.
 *
 * REGLAS QUE ESTAS PIEZAS YA CUMPLEN (y que quien las usa no debe romper):
 * · Ninguna calcula plata ni porcentajes: reciben cifras del backend y sólo
 *   las llevan a píxeles. `formato` lo pasa quien usa (`formatCOP`,
 *   `formatPct`, `formatCantidad`, `formatDuracion` de `@/lib`).
 * · `null` ≠ 0: un `null` se dibuja como hueco rayado y se lee «sin dato».
 * · Tinta de datos: `--data-ink` / `--data-1..5` / `--diverge-*` / `--data-muted`
 *   (`index.css`). El añil (`--primary`) nunca es dato. El texto va en tinta
 *   de texto, nunca del color de la serie.
 * · Cada una es `role="img"` con un `aria-label` resumido; el detalle
 *   completo está en la tabla gemela de `ChartFrame`. Un solo punto de
 *   tabulación por gráfico; ← → recorren los puntos con el globo.
 */
export { ChartFrame } from "./ChartFrame"
export type { ChartFrameProps, ColumnaTabla, Muestra, TablaGemela } from "./ChartFrame"
export { ColumnChart } from "./ColumnChart"
export type { ColumnChartProps, ColumnDatum } from "./ColumnChart"
export { BarList } from "./BarList"
export type { BarListDatum, BarListProps } from "./BarList"
export { TrendLine } from "./TrendLine"
export type { TrendLineProps, TrendPunto } from "./TrendLine"
export { Stacked100 } from "./Stacked100"
export type { Parte, Stacked100Props } from "./Stacked100"
export { DivergingBars } from "./DivergingBars"
export type { DivergingBarsProps, DivergingDatum } from "./DivergingBars"
export { Pareto } from "./Pareto"
export type { ParetoDatum, ParetoProps } from "./Pareto"
export { QuadrantScatter } from "./QuadrantScatter"
export type { Eje, QuadrantScatterProps, ScatterPunto } from "./QuadrantScatter"
export { ThresholdDots } from "./ThresholdDots"
export type { ThresholdDotsProps, ThresholdPunto } from "./ThresholdDots"
export { Medidor } from "./Medidor"
export type { MedidorProps } from "./Medidor"
