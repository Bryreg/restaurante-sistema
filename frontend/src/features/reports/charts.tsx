/**
 * Lo que queda del primer par de gráficos de «Hoy»/«Ventas». Esas dos
 * pantallas ya dibujan con el sistema compartido (`@/components/charts`:
 * `ChartFrame` con titular y tabla gemela, `ColumnChart`, `BarList`,
 * `Stacked100`, `TrendLine`). La línea vieja (`TrendLine` de acá, sin ejes ni
 * marcadores) se borró: no tenía más usos.
 *
 * `CategoryBars` sigue porque otra pantalla lo importa
 * (`features/orders/OrdersAdminPage.tsx`, tiempos de cocina por estación) y
 * su API no es la de `BarList`. Quedó corregido en lo que el informe de
 * visualización marcó como trampa (científico #6): ya no usa `Math.abs` —un
 * negativo no se dibuja como si fuera positivo: su barra queda en cero y la
 * cifra con signo al lado— y la tinta es la de datos (`--data-ink`), no el
 * añil de acción. Para cifras con signo, `DivergingBars`; para lo nuevo,
 * `BarList`.
 */

export interface CategoryBarDatum {
  key: string
  label: string
  value: number
}

/** Para pantallas nuevas, `BarList` de `@/components/charts`. */
export function CategoryBars({
  data,
  formatValue = (v: number) => String(v),
  emptyLabel = "Sin datos en este período",
}: {
  data: CategoryBarDatum[]
  formatValue?: (value: number) => string
  emptyLabel?: string
}): React.JSX.Element {
  if (data.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>
  }
  const max = Math.max(1, ...data.map((d) => d.value))
  return (
    <div
      className="space-y-2"
      role="img"
      aria-label="Comparación por categoría; el detalle exacto está en la tabla de abajo"
    >
      {data.map((d) => (
        <div key={d.key} className="flex items-center gap-2 text-sm">
          <span className="w-28 shrink-0 truncate text-muted-foreground" title={d.label}>
            {d.label}
          </span>
          <span className="h-2.5 min-w-8 flex-1">
            <span
              className="block h-full rounded-r-[4px]"
              style={{ width: `${(Math.max(0, d.value) / max) * 100}%`, background: "var(--data-ink)" }}
            />
          </span>
          <span className="w-24 shrink-0 text-right tabular-nums">{formatValue(d.value)}</span>
        </div>
      ))}
    </div>
  )
}
