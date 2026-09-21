import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getSupplierReliability, type SupplierOut } from "@/api/purchases"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import DateRangeFilter from "@/components/DateRangeFilter"
import { errorMessage } from "@/lib/errors"

import { defaultDateRange, formatPct } from "./lib"

/**
 * Panel de confiabilidad de un proveedor (SPEC-NEGOCIO §5.6 / §9.3: «¿a
 * quién le debo?» también responde «¿en quién confío?»): recibido ÷
 * facturado, porcentaje de recepciones con factura, deriva promedio de
 * precio — los tres YA calculados por el servidor
 * (`GET /admin/suppliers/{id}/reliability`); esta pantalla sólo los
 * formatea.
 *
 * **Patrón 5, y el motivo por el que esta pantalla lo necesitaba**: sin
 * recepciones en el rango cada número llega `null`, y un `0 %` ahí mentiría
 * dos veces seguidas —«impecable» en recibido÷facturado y «nunca factura» en
 * el share—. `StatTile` obliga a dar la frase que explica el `—`, y lo
 * dibuja apagado y nunca en rojo: no saber no es estar mal.
 *
 * Cada tarjeta lleva además **de qué está hecha**: un porcentaje sobre 2
 * recepciones no es el mismo dato que uno sobre 40, y sin el denominador a
 * la vista se leen igual.
 */
export function SupplierReliabilityDialog({ supplier }: { supplier: SupplierOut }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState(() => defaultDateRange(90))

  const query = useQuery({
    queryKey: ["purchases", "suppliers", supplier.id, "reliability", range.from, range.to],
    queryFn: () => getSupplierReliability(supplier.id, range),
    enabled: open,
  })

  const data = query.data
  const receptions = data?.receptions ?? 0
  /** El denominador, en palabras: de qué está hecha cada cifra. */
  const sobre = `Sobre ${receptions} ${receptions === 1 ? "recepción" : "recepciones"} en el rango.`
  const sinDatos = "Sin recepciones de este proveedor en el rango: no es 0 %, es que no hay con qué medirlo. Ampliá las fechas."

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Confiabilidad</DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Confiabilidad de {supplier.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <DateRangeFilter idPrefix="sup-reliability" from={range.from} to={range.to} onChange={setRange} />

          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">Calculando…</p>
          ) : query.isError ? (
            <EmptyState
              role="alert"
              reason="error"
              title="No se pudo calcular la confiabilidad"
              description={errorMessage(query.error)}
              action={{ label: "Reintentar", onClick: () => void query.refetch() }}
            />
          ) : data ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <StatTile
                label="Recepciones en el rango"
                value={String(data.receptions)}
                hint="Todo lo de abajo se mide sobre éstas. Con dos o tres, los porcentajes dicen poco."
              />
              <StatTile
                label="Recibido ÷ facturado"
                {...(data.received_over_invoiced_pct === null
                  ? { value: null as null, nullNote: sinDatos }
                  : { value: formatPct(data.received_over_invoiced_pct) })}
                hint={`Debajo de 100 % está cobrando más de lo que entrega. ${sobre}`}
              />
              <StatTile
                label="Recepciones con factura"
                {...(data.invoice_share_pct === null
                  ? { value: null as null, nullNote: sinDatos }
                  : { value: formatPct(data.invoice_share_pct) })}
                hint={`Lo que entró sin factura no respalda el costo ante la DIAN. ${sobre}`}
              />
              <StatTile
                label="Deriva promedio de precio"
                {...(data.avg_price_drift_pct === null
                  ? { value: null as null, nullNote: sinDatos }
                  : { value: formatPct(data.avg_price_drift_pct) })}
                hint={`Cuánto se le movió el precio contra su propio promedio. ${sobre}`}
              />
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SupplierReliabilityDialog
