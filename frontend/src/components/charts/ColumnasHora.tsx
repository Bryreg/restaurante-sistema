import { cn } from "@/lib/utils"

export interface ColumnaHora {
  key: string
  /** «06», «07»…: la hora bajo la columna. */
  etiqueta: string
  /** `null` = la hora todavía no llega (no es 0): columna clara a todo el alto. */
  valor: number | null
  /** El mismo día de la semana pasada, día completo; `null` = sin raya. */
  referencia?: number | null
}

/**
 * **Las ventas por hora del estilo «Burbujas»** (handoff, `MinHoyC`): una
 * columna por hora, sin eje. Lo que ya pasó va en gris (`--data-1`), la hora
 * en curso en tinta, lo que falta como una columna clara a todo el alto, y
 * la raya del mismo día de la semana pasada encima de cada columna, en tinta
 * al 55 %. Las alturas son dibujo: se escalan contra el mayor valor a la
 * vista. La cifra exacta va en el `title` de cada columna y en la tabla para
 * lectores de pantalla.
 */
export function ColumnasHora({
  datos,
  actual,
  formato,
  resumen,
  etiquetaSerie = "Hoy",
  etiquetaReferencia,
  alto = 140,
}: {
  datos: ColumnaHora[]
  actual?: string
  formato: (v: number) => string
  resumen: string
  etiquetaSerie?: string
  etiquetaReferencia?: string
  alto?: number
}): React.JSX.Element {
  const tope = Math.max(1, ...datos.flatMap((d) => [d.valor ?? 0, d.referencia ?? 0]))
  const pct = (v: number) => `${Math.min(100, (v / tope) * 100)}%`
  const columnas = { gridTemplateColumns: `repeat(${datos.length}, minmax(0, 1fr))` }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="img" aria-label={resumen} className="grid items-end gap-1.5" style={{ ...columnas, height: alto }}>
        {datos.map((d) => {
          const pendiente = d.valor === null
          const enCurso = d.key === actual
          return (
            <div
              key={d.key}
              data-columna={d.key}
              title={`${d.etiqueta}: ${pendiente ? "todavía no llega" : formato(d.valor as number)}${
                d.referencia != null ? ` · ${etiquetaReferencia ?? "referencia"} ${formato(d.referencia)}` : ""
              }`}
              // Ancho máximo: con pocas horas la columna no se vuelve un bloque.
              className="relative mx-auto flex h-full w-full max-w-11 items-end"
            >
              <span
                data-pendiente={pendiente ? "" : undefined}
                data-ahora={enCurso ? "" : undefined}
                className={cn(
                  "w-full rounded-md",
                  pendiente ? "bg-muted" : enCurso ? "bg-foreground" : "bg-data-bar",
                )}
                style={{ height: pendiente ? "100%" : pct(d.valor as number) }}
              />
              {d.referencia != null ? (
                <span
                  data-referencia=""
                  className="absolute -inset-x-0.5 border-t-2 border-foreground opacity-55"
                  style={{ bottom: pct(d.referencia) }}
                />
              ) : null}
            </div>
          )
        })}
      </div>
      <div className="grid gap-1.5 text-center text-[11px]" style={columnas} aria-hidden="true">
        {datos.map((d) => (
          <span
            key={d.key}
            className={d.key === actual ? "font-bold text-foreground" : "text-muted-foreground"}
          >
            {d.etiqueta}
          </span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{resumen}</caption>
        <thead>
          <tr>
            <th scope="col">Hora</th>
            <th scope="col">{etiquetaSerie}</th>
            {etiquetaReferencia ? <th scope="col">{etiquetaReferencia}</th> : null}
          </tr>
        </thead>
        <tbody>
          {datos.map((d) => (
            <tr key={d.key}>
              <th scope="row">{d.etiqueta}</th>
              <td>{d.valor === null ? "todavía no llega" : formato(d.valor)}</td>
              {etiquetaReferencia ? <td>{d.referencia != null ? formato(d.referencia) : "—"}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
