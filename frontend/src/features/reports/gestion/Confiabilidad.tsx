import { ArrowRight, CircleAlert, CircleCheck, TriangleAlert } from "lucide-react"
import { useId } from "react"
import { Link } from "react-router-dom"

import type { ReliabilityOut } from "@/api/reports"
import { cn } from "@/lib/utils"

import { RELIABILITY_ROUTE } from "./lib"

/**
 * «¿Le puedo creer a estos números?» (h10): lo que hace dudar de las cifras
 * del período, cada cosa con el camino para arreglarla. La lista y su orden
 * (lo crítico primero) los decide el servidor; acá sólo se pinta. Sin nada
 * que reportar, una línea calma: también es una respuesta.
 */
export function BannerConfiabilidad({
  data,
  periodo,
  className,
}: {
  data: ReliabilityOut
  /** «del período», «del mes»: de qué números se habla. */
  periodo: string
  className?: string
}): React.JSX.Element {
  const id = useId()
  if (data.reliable) {
    return (
      <p
        className={cn("flex items-center gap-2 rounded-lg border bg-card px-4 py-2.5 text-sm text-muted-foreground", className)}
        data-slot="confiabilidad"
      >
        <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
        ¿Le puedo creer a estos números? Sí: no hay nada pendiente que tuerza los números {periodo}.
      </p>
    )
  }
  const criticos = data.items.filter((i) => i.severity === "critical").length
  return (
    <section
      aria-labelledby={id}
      data-slot="confiabilidad"
      className={cn(
        "rounded-lg border px-4 py-3",
        criticos > 0 ? "border-destructive/30 bg-destructive/5" : "border-warning/45 bg-warning/10",
        className,
      )}
    >
      <h2 id={id} className="flex items-center gap-2 text-sm font-bold">
        <TriangleAlert className={cn("size-4 shrink-0", criticos > 0 ? "text-destructive" : "text-warning")} aria-hidden="true" />
        ¿Le puedo creer a estos números? Todavía no del todo:{" "}
        {data.items.length === 1 ? "hay una cosa" : `hay ${data.items.length} cosas`} que los tuercen {periodo}.
      </h2>
      <ul className="mt-2 space-y-2">
        {data.items.map((item) => {
          const ruta = RELIABILITY_ROUTE[item.key]
          return (
            <li key={item.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
              {item.severity === "critical" ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Grave" />
              ) : (
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Revisar" />
              )}
              <span className="min-w-0 flex-1">
                <b className="font-semibold">{item.title}.</b> {item.detail}{" "}
                <span className="text-xs text-muted-foreground">Afecta: {item.affects}.</span>
              </span>
              <Link
                to={ruta.to}
                className="inline-flex items-center gap-1 text-sm font-bold whitespace-nowrap text-primary hover:underline"
              >
                {ruta.label}
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
