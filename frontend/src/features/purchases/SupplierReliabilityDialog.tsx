import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getSupplierReliability, type SupplierOut } from "@/api/purchases"
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
 * formatea. Sin recepciones en el rango, cada número es `null` y se dice
 * «sin datos» — nunca «0 %», que mentiría "impecable" o "nunca factura".
 */
export function SupplierReliabilityDialog({ supplier }: { supplier: SupplierOut }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [range, setRange] = useState(() => defaultDateRange(90))

  const query = useQuery({
    queryKey: ["purchases", "suppliers", supplier.id, "reliability", range.from, range.to],
    queryFn: () => getSupplierReliability(supplier.id, range),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Confiabilidad</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confiabilidad de {supplier.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <DateRangeFilter idPrefix="sup-reliability" from={range.from} to={range.to} onChange={setRange} />

          {query.isLoading ? (
            <p className="text-sm text-muted-foreground">Calculando…</p>
          ) : query.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(query.error)}
            </p>
          ) : query.data ? (
            <dl className="grid grid-cols-2 gap-4 rounded-md border p-4 text-sm">
              <div>
                <dt className="text-muted-foreground">Recepciones en el rango</dt>
                <dd className="text-lg font-semibold tabular-nums">{query.data.receptions}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Recibido ÷ facturado</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPct(query.data.received_over_invoiced_pct)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Recepciones con factura</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPct(query.data.invoice_share_pct)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Deriva promedio de precio</dt>
                <dd className="text-lg font-semibold tabular-nums">{formatPct(query.data.avg_price_drift_pct)}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SupplierReliabilityDialog
