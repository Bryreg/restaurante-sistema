import { cn } from "@/lib/utils"

/** Un renglón del libro. `value` llega **ya formateado**: acá no se calcula nada. */
export interface LedgerRow {
  label: string
  value: string
  /** `"subtract"` dibuja el renglón como lo que se resta (impuesto, descuento). */
  kind?: "add" | "subtract"
}

export interface HeadlineFigureProps {
  /** El rótulo de la cifra rectora: «Ventas netas de hoy». */
  label: string
  /** La cifra, ya formateada con `formatCOP`. */
  value: string
  /** De qué está hecha: «148 comandas pagadas · 12 horas de servicio · sigue abierto». */
  note?: string
  /**
   * **El libro que deriva la cifra.** El tipo exige **dos renglones como
   * mínimo** más el total, porque la plata nunca es un número suelto: es una
   * resta —cobrado en caja − impuesto al consumo = ventas netas—. Un «libro»
   * de un solo renglón no deriva nada, y por eso no compila
   * (`docs/PATRONES-ADMIN.md` § 4).
   */
  ledger: {
    rows: readonly [LedgerRow, LedgerRow, ...LedgerRow[]]
    total: { label: string; value: string }
  }
  /**
   * **Abajo de la raya**: lo que NO es venta. Las propinas van acá, rotuladas
   * como que pasan de largo — eso es lo que mata la tarjeta «Propinas», que
   * es un error de categoría (Ley 1935 de 2018: la propina no es del
   * restaurante).
   */
  belowTheLine?: { label: string; value: string }
  /** La comparación contra el mismo día de la semana pasada **a la misma hora**. */
  comparison?: { label: string; delta: string; detail?: string }
  className?: string
}

/**
 * **Banda de cifra** (`docs/PATRONES-ADMIN.md` § 4). Tres partes: la cifra
 * rectora, el libro que la deriva y la comparación.
 *
 * **Una cifra rectora por pantalla, nunca dos.** Eso no lo puede hacer
 * cumplir un componente —no ve la pantalla entera— así que queda dicho acá y
 * lo mira la revisión: si una pantalla monta dos bandas, ninguna de las dos
 * es rectora.
 *
 * Aplica a Ventas, Dinero, Cierre de caja, Nómina, Compras y Analítica.
 */
export function HeadlineFigure({
  label,
  value,
  note,
  ledger,
  belowTheLine,
  comparison,
  className,
}: HeadlineFigureProps): React.JSX.Element {
  return (
    <section
      className={cn(
        "grid items-center gap-5 rounded-lg border bg-card p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)_minmax(0,190px)]",
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-[0.7rem] tracking-wider text-muted-foreground uppercase">{label}</p>
        <p className="mt-0.5 text-4xl leading-none font-bold tracking-tight whitespace-nowrap tabular-nums">
          {value}
        </p>
        {note ? <p className="mt-1.5 text-xs text-muted-foreground">{note}</p> : null}
      </div>

      <dl className="min-w-0 border-border lg:border-l lg:pl-4">
        {ledger.rows.map((row, i) => (
          <div key={i} className="flex items-baseline gap-3 py-0.5 text-sm">
            <dt className="min-w-0 text-muted-foreground">{row.label}</dt>
            <dd
              className={cn(
                "ml-auto whitespace-nowrap tabular-nums",
                row.kind === "subtract" && "text-muted-foreground",
              )}
            >
              {row.kind === "subtract" ? `−${row.value}` : row.value}
            </dd>
          </div>
        ))}
        <div className="mt-1 flex items-baseline gap-3 border-t-2 border-input pt-1.5 text-sm font-bold">
          <dt className="min-w-0">{ledger.total.label}</dt>
          <dd className="ml-auto whitespace-nowrap tabular-nums">{ledger.total.value}</dd>
        </div>
        {belowTheLine ? (
          <div className="mt-2 flex items-baseline gap-3 border-t border-dashed border-input pt-1.5 text-xs text-muted-foreground">
            <dt className="min-w-0">{belowTheLine.label}</dt>
            <dd className="ml-auto font-bold whitespace-nowrap text-foreground tabular-nums">
              {belowTheLine.value}
            </dd>
          </div>
        ) : null}
      </dl>

      {comparison ? (
        <div className="min-w-0 border-border text-xs text-muted-foreground lg:border-l lg:pl-4">
          <p>{comparison.label}</p>
          <p className="my-0.5 text-lg font-bold text-foreground tabular-nums">{comparison.delta}</p>
          {comparison.detail ? <p className="whitespace-nowrap tabular-nums">{comparison.detail}</p> : null}
        </div>
      ) : null}
    </section>
  )
}

export default HeadlineFigure
