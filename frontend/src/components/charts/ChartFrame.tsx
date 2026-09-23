import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

import { MarcoContext } from "./nucleo"

export interface ColumnaTabla {
  key: string
  header: string
  align?: "left" | "right" | "center"
}

export interface TablaGemela {
  columnas: ColumnaTabla[]
  filas: Record<string, ReactNode>[]
}

export interface Muestra {
  /** Cuántos casos hay detrás de la cifra (comandas, días, platos…). Contar sí se permite. */
  n: number
  /** En qué se cuenta: «comandas», «días», «unidades vendidas». */
  unidad: string
  /** La ventana que cubre, ya escrita: «8 al 21 sep», «16 h». */
  ventana?: string
  /** Debajo de esto la muestra es chica. Por defecto 20. */
  minimo?: number
}

export interface ChartFrameProps {
  /** La CONCLUSIÓN, no el nombre del gráfico: «El sábado vendió el doble que el lunes». */
  titular: string
  /** Qué se grafica y en qué unidad: «Venta neta por día, en pesos». */
  detalle?: ReactNode
  muestra?: Muestra
  /** La tabla gemela: el equivalente accesible y completo del gráfico. */
  tabla: TablaGemela
  /** Controles propios del gráfico (a la derecha del titular). Los filtros van arriba de todo, no acá. */
  acciones?: ReactNode
  className?: string
  children: ReactNode
}

const ALINEACION = { left: "text-left", right: "text-right", center: "text-center" } as const

/**
 * El marco de todo gráfico: titular con la conclusión, la base (n y ventana),
 * el gráfico y su tabla gemela, que se alterna con «Ver tabla»/«Ver gráfico».
 * Con muestra chica (n < mínimo) se marca en gris y se dice por qué.
 */
export function ChartFrame({
  titular,
  detalle,
  muestra,
  tabla,
  acciones,
  className,
  children,
}: ChartFrameProps): React.JSX.Element {
  const [verTabla, setVerTabla] = useState(false)
  const idTabla = useId()
  const idTitular = useId()
  const tablaRef = useRef<HTMLTableElement>(null)

  const pedirFoco = useRef(false)

  const abrirTabla = useCallback(() => {
    pedirFoco.current = true
    setVerTabla(true)
  }, [])
  // Quien abre la tabla desde adentro del gráfico («y 4 más») cae en ella.
  useEffect(() => {
    if (verTabla && pedirFoco.current) {
      pedirFoco.current = false
      tablaRef.current?.focus()
    }
  }, [verTabla])
  const marco = useMemo(() => ({ verTabla: abrirTabla }), [abrirTabla])

  const minimo = muestra?.minimo ?? 20
  const chica = muestra !== undefined && muestra.n < minimo

  return (
    <figure
      aria-labelledby={idTitular}
      className={cn("m-0 flex min-w-0 flex-col gap-3", className)}
      data-slot="chart-frame"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 id={idTitular} className="text-base leading-snug font-semibold text-foreground">
            {titular}
          </h3>
          {detalle ? <div className="text-sm text-muted-foreground">{detalle}</div> : null}
        </div>
        {acciones ? <div className="flex shrink-0 items-center gap-2">{acciones}</div> : null}
      </div>

      {muestra ? (
        chica ? (
          <p className="sin-dato px-2 py-1 text-xs not-italic" data-muestra="chica">
            <span className="font-medium">
              Muestra chica: {muestra.n} {muestra.unidad}
            </span>
            {muestra.ventana ? ` en ${muestra.ventana}` : ""}
            {`. Con menos de ${minimo} ${muestra.unidad} un caso suelto mueve mucho el resultado: tomalo como indicio, no como cifra firme.`}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground" data-muestra="ok">
            Base: {muestra.n} {muestra.unidad}
            {muestra.ventana ? ` · ${muestra.ventana}` : ""}
          </p>
        )
      ) : null}

      <MarcoContext.Provider value={marco}>
        <div hidden={verTabla} className={cn("min-w-0", chica && "opacity-80")}>
          {children}
        </div>
      </MarcoContext.Provider>

      {verTabla ? (
        <div className="min-w-0 overflow-x-auto">
          <table
            id={idTabla}
            ref={tablaRef}
            tabIndex={-1}
            className="w-full text-sm outline-none"
          >
            <caption className="sr-only">{titular}</caption>
            <thead>
              <tr className="border-b">
                {tabla.columnas.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn("px-2 py-1.5 font-medium text-muted-foreground", ALINEACION[c.align ?? "left"])}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tabla.filas.map((fila, i) => (
                <tr key={i} className="border-b last:border-0">
                  {tabla.columnas.map((c) => (
                    <td key={c.key} className={cn("px-2 py-1.5", ALINEACION[c.align ?? "left"])}>
                      {fila[c.key] ?? "—"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div>
        <button
          type="button"
          aria-pressed={verTabla}
          aria-controls={verTabla ? idTabla : undefined}
          onClick={() => setVerTabla((v) => !v)}
          className="rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {verTabla ? "Ver gráfico" : "Ver tabla"}
        </button>
      </div>
    </figure>
  )
}
