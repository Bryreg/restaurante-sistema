import { Link } from "react-router-dom"

import type { AreaCountAreaTodayOut, AreaCountFlagOut } from "@/api/reports"
import { formatInstant } from "@/lib/businessDate"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { WINDOW_LABEL, areaCountHref, flagPhrase } from "./areaCountLib"
import { RecountDialog } from "./RecountDialog"

function Hecho({ done, missing }: { done: AreaCountAreaTodayOut["opening"]; missing: "rojo" | "apagado" }): React.JSX.Element {
  if (done) {
    return (
      <span>
        {done.employee_name} · <span className="text-muted-foreground">{formatInstant(done.counted_at)}</span>
      </span>
    )
  }
  return (
    <span className={cn(missing === "rojo" ? "font-bold text-destructive" : "text-muted-foreground")}>
      {missing === "rojo" ? "Sin contar" : "Todavía no"}
    </span>
  )
}

/**
 * La tarjeta «Conteo por área» de Hoy (`inventory.shift_counts`): qué áreas
 * contaron al abrir y al cerrar —sin conteo de apertura va en rojo, pero no
 * bloquea nada—, los artículos fuera del umbral diciendo si fue de noche o
 * en el turno, y la respuesta de cada recuento sorpresa con su diferencia
 * contra el sistema. Toda cifra viene del servidor.
 */
export function AreaCountsTodayCard({
  storeId,
  areas,
  flags,
  pendingRecounts,
}: {
  storeId: number
  areas: AreaCountAreaTodayOut[]
  flags: AreaCountFlagOut[]
  pendingRecounts: number
}): React.JSX.Element {
  return (
    <section aria-labelledby="hoy-conteo-area" className="min-w-0 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="hoy-conteo-area" className="text-sm font-bold">
          Conteo por área
        </h2>
        <div className="ml-auto">
          <RecountDialog storeId={storeId} triggerVariant="outline" />
        </div>
      </div>
      {areas.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No hay áreas con artículos para contar. Se arman en{" "}
          <Link to="/admin/inventario?tab=por-area" className="text-primary underline underline-offset-2">
            Inventario › Conteo por área
          </Link>
          .
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <caption className="sr-only">Qué áreas contaron hoy</caption>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="py-1 font-medium">
                Área
              </th>
              <th scope="col" className="py-1 font-medium">
                Apertura
              </th>
              <th scope="col" className="py-1 font-medium">
                Cierre
              </th>
            </tr>
          </thead>
          <tbody>
            {areas.map((a) => (
              <tr key={a.area_id} className="border-t">
                <th scope="row" className="py-1.5 text-left font-bold">
                  {a.area_name}
                </th>
                <td className="py-1.5">
                  <Hecho done={a.opening} missing="rojo" />
                </td>
                <td className="py-1.5">
                  <Hecho done={a.closing} missing="apagado" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {flags.length > 0 ? (
        <ul className="mt-3 space-y-1.5 border-t pt-3 text-sm">
          {flags.map((f) => (
            <li key={`${f.count_id}-${f.ingredient_id}`} className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn(f.flagged ? "font-bold text-destructive" : undefined)}>{flagPhrase(f)}</span>
              <span className="text-muted-foreground">
                · {f.area_name} · {WINDOW_LABEL[f.window]}
                {f.shortage_value !== null ? ` · ${formatCOP(f.shortage_value)}` : " · sin valor"}
              </span>
              <Link to={areaCountHref(f.count_id)} className="ml-auto text-primary underline underline-offset-2">
                Ver detalle
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {pendingRecounts > 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {pendingRecounts} recuento{pendingRecounts === 1 ? "" : "s"} pedido{pendingRecounts === 1 ? "" : "s"} esperando
          en el POS.
        </p>
      ) : null}
      <p className="mt-2 text-xs text-muted-foreground">Contar no bloquea abrir ni cerrar el turno.</p>
    </section>
  )
}
