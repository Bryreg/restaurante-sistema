import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getSupplierReliability, type IngredientReliabilityOut, type SupplierOut } from "@/api/purchases"
import { DenseTable, type DenseColumn } from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import DateRangeFilter from "@/components/DateRangeFilter"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { defaultDateRange } from "./lib"
import { formatDeriva, MUESTRA_CHICA_RECEPCIONES, tonoDeriva, tonoRecibido, tonoTarjeta } from "./reliability"
import { Indicador, Recepciones } from "./ReliabilityMarks"

/** El `_bp` del servidor; si un doble viejo sólo trae el por ciento entero, se lee ése (misma cifra, otra unidad). */
function bpDe(bp: number | null | undefined, pct: number | null): number | null {
  if (bp !== undefined) return bp
  return pct === null ? null : pct * 100
}

const INGREDIENT_COLUMNS: readonly DenseColumn<IngredientReliabilityOut>[] = [
  { key: "name", header: "Insumo", kind: "name", cell: (i) => i.name },
  { key: "n", header: "Recepciones", kind: "number", cell: (i) => <Recepciones n={i.n_receptions} /> },
  {
    key: "received",
    header: "Recibido ÷ facturado",
    kind: "number",
    cell: (i) =>
      i.received_over_invoiced_bp === null ? (
        "—"
      ) : (
        <Indicador tono={tonoRecibido(i.received_over_invoiced_bp)}>{formatPct(i.received_over_invoiced_bp)}</Indicador>
      ),
    cellTitle: (i) => (i.received_over_invoiced_bp === null ? "Sin cantidad facturada contra qué medir" : undefined),
  },
  {
    key: "drift",
    header: "Deriva de precio",
    kind: "number",
    cell: (i) =>
      i.price_drift_bp === null ? (
        "—"
      ) : (
        <Indicador tono={tonoDeriva(i.price_drift_bp)}>{formatDeriva(i.price_drift_bp)}</Indicador>
      ),
    cellTitle: (i) =>
      i.price_drift_bp === null
        ? "Sin una compra anterior del mismo insumo contra qué medir"
        : `Sobre ${i.n_price_comparisons} ${i.n_price_comparisons === 1 ? "comparación" : "comparaciones"} contra la compra anterior`,
  },
  { key: "spend", header: "Comprado", kind: "number", cell: (i) => formatCOP(i.spend) },
]

/**
 * Panel de confiabilidad de un proveedor (SPEC-NEGOCIO §5.6 / §9.3: «¿a
 * quién le debo?» también responde «¿en quién confío?»): recibido ÷
 * facturado, porcentaje de recepciones con factura y deriva de precio — ya
 * calculados por el servidor (`GET /admin/suppliers/{id}/reliability`);
 * esta pantalla sólo los formatea.
 *
 * Informe científico #5: el cálculo es POR INSUMO (sólo dentro de un insumo
 * las cantidades están en la misma unidad) y el resumen del proveedor es la
 * mediana pesada por plata; la deriva tiene signo (▲ subió, ▼ bajó). Por
 * eso el diálogo muestra también la tabla por insumo: es de dónde sale el
 * resumen. Los umbrales de alerta están en `./reliability`.
 *
 * **Patrón 5**: sin recepciones en el rango cada número llega `null`, y un
 * `0 %` ahí mentiría dos veces seguidas —«impecable» en recibido÷facturado y
 * «nunca factura» en el share—. `StatTile` obliga a dar la frase que
 * explica el `—`, y lo dibuja apagado y nunca en rojo.
 */
export function SupplierReliabilityDialog({
  supplier,
  open: openControlado,
  onOpenChange,
}: {
  supplier: SupplierOut
  /**
   * **Controlado** desde afuera cuando lo abre un ítem del menú «⋯» de la
   * fila (`SuppliersTab`, mapa de pantallas regla 3): entonces no dibuja su
   * propio botón. Sin estas dos props se abre con su botón «Confiabilidad».
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const [openPropio, setOpenPropio] = useState(false)
  const controlado = openControlado !== undefined
  const open = controlado ? openControlado : openPropio
  const setOpen = (value: boolean) => {
    if (!controlado) setOpenPropio(value)
    onOpenChange?.(value)
  }
  const [range, setRange] = useState(() => defaultDateRange(90))

  const query = useQuery({
    queryKey: ["purchases", "suppliers", supplier.id, "reliability", range.from, range.to],
    queryFn: () => getSupplierReliability(supplier.id, range),
    enabled: open,
  })

  const data = query.data
  const receptions = data?.n_receptions ?? data?.receptions ?? 0
  /** El denominador, en palabras: de qué está hecha cada cifra. */
  const sobre = `Sobre ${receptions} ${receptions === 1 ? "recepción" : "recepciones"} en el rango.`
  const sinDatos = "Sin recepciones de este proveedor en el rango: no es 0 %, es que no hay con qué medirlo. Ampliá las fechas."

  const recibido = data ? bpDe(data.received_over_invoiced_bp, data.received_over_invoiced_pct) : null
  const conFactura = data ? bpDe(data.invoice_share_bp, data.invoice_share_pct) : null
  const deriva = data ? bpDe(data.price_drift_bp, data.avg_price_drift_pct) : null
  const insumos = data?.ingredients ?? []

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {controlado ? null : <DialogTrigger render={<Button variant="outline" size="sm" />}>Confiabilidad</DialogTrigger>}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Confiabilidad de {supplier.name}</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
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
            <>
              {receptions > 0 && receptions < MUESTRA_CHICA_RECEPCIONES ? (
                <p className="sin-dato px-2 py-1 text-xs not-italic" data-muestra="chica">
                  <span className="font-medium">Muestra chica: {sobre}</span> Con menos de {MUESTRA_CHICA_RECEPCIONES}{" "}
                  un pedido raro mueve la cifra entera: tomala como indicio, no como cifra firme.
                </p>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <StatTile
                  label="Recepciones en el rango"
                  value={String(receptions)}
                  hint={
                    data.n_ingredients !== undefined
                      ? `De ${data.n_ingredients} ${data.n_ingredients === 1 ? "insumo" : "insumos"}${data.spend !== undefined ? `, por ${formatCOP(data.spend)}` : ""}. Todo lo de abajo se mide sobre éstas.`
                      : "Todo lo de abajo se mide sobre éstas. Con dos o tres, los porcentajes dicen poco."
                  }
                />
                <StatTile
                  label="Recibido ÷ facturado"
                  tone={tonoTarjeta(tonoRecibido(recibido))}
                  {...(recibido === null ? { value: null as null, nullNote: sinDatos } : { value: formatPct(recibido) })}
                  hint={`Debajo de 100 % está cobrando más de lo que entrega. Mediana por insumo, pesada por plata. ${sobre}`}
                />
                <StatTile
                  label="Recepciones con factura"
                  {...(conFactura === null ? { value: null as null, nullNote: sinDatos } : { value: formatPct(conFactura) })}
                  hint={`Lo que entró sin factura no respalda el costo ante la DIAN. ${sobre}`}
                />
                <StatTile
                  label="Deriva de precio"
                  tone={tonoTarjeta(tonoDeriva(deriva))}
                  {...(deriva === null
                    ? {
                        value: null as null,
                        nullNote:
                          receptions === 0
                            ? sinDatos
                            : "Ningún insumo tiene una compra anterior con este proveedor contra qué medir el precio.",
                      }
                    : { value: formatDeriva(deriva) })}
                  hint={`Cuánto se movió el precio contra la compra anterior de cada insumo (▲ subió, ▼ bajó); mediana pesada por plata. ${sobre}`}
                />
              </div>
              {insumos.length > 0 ? (
                <DenseTable
                  caption="Confiabilidad por insumo: de acá sale el resumen del proveedor."
                  columns={INGREDIENT_COLUMNS}
                  rows={insumos}
                  rowKey={(i) => String(i.ingredient_id)}
                  maxBodyHeightPx={280}
                  note="Por insumo porque sólo dentro de un insumo las cantidades están en la misma unidad. Ordenados por plata: el que más pesa primero."
                />
              ) : null}
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default SupplierReliabilityDialog
