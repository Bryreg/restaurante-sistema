import { useQuery } from "@tanstack/react-query"

import { listPrepBatches, prepBatchesCsvUrl, type PreparationAdminOut } from "@/api/recipes"
import { CsvExportButton } from "@/components/CsvExportButton"
import {
  DenseTable,
  DenseTableBar,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"

import { CostValue, VarianceBadge } from "./costDisplay"

/**
 * **La leyenda del pie** (patrón 8 d). Las tres distinciones que esta tabla
 * separa a propósito y que un lector apurado junta: lo esperado no es lo
 * real, «sin costo» no es «$ 0», y un lote cerrado no es un lote gastado.
 */
const BATCHES_LEGEND: readonly LegendEntry[] = [
  {
    term: "Diferencia",
    meaning: (
      <>
        cuánto se apartó lo <b>real</b> de lo <b>esperado</b> según la receta. Pasado el <b>15 %</b> la fila se
        marca: o la receta no refleja lo que la cocina hace, o el lote no rindió.
      </>
    ),
  },
  {
    term: "Sin costo",
    meaning: (
      <>
        no es <b>$ 0</b> — no se pudo valorar el lote porque algún componente no tiene costo conocido. Un lote
        que costó cero no existe.
      </>
    ),
  },
  {
    term: "Cerrado",
    meaning:
      "el lote ya no descuenta: se agotó, venció o lo cerró un cambio de modo. No es lo mismo que consumido, y por eso el motivo va escrito.",
  },
]

/**
 * Lotes de una preparación por lote (spec §9.3 "Preparaciones": stock por
 * lote, costo real, vencimiento, estado, rendimiento esperado vs real con
 * la diferencia resaltada > 15 %). Preparaciones `exploded` no tienen lotes
 * — el botón que abre este diálogo ni se ofrece para ellas.
 */
export function PrepBatchesPanel({
  preparation,
  open,
  onOpenChange,
}: {
  preparation: PreparationAdminOut
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const batchesQuery = useQuery({
    queryKey: ["recipes", "prep-batches", preparation.id],
    queryFn: () => listPrepBatches(preparation.id),
    enabled: open,
  })

  const batches = batchesQuery.data ?? []
  const abiertos = batches.filter((b) => !b.closed_at).length

  const columns: readonly DenseColumn<(typeof batches)[number]>[] = [
    {
      key: "produced",
      header: "Producido",
      kind: "name",
      cell: (b) => <TimeAgo iso={b.produced_at} />,
    },
    {
      key: "expected",
      header: "Esperado",
      kind: "number",
      cell: (b) => `${b.qty_expected} ${b.unit}`,
    },
    { key: "real", header: "Real", kind: "number", cell: (b) => `${b.qty_real} ${b.unit}` },
    {
      key: "variance",
      header: "Diferencia",
      cell: (b) => <VarianceBadge pct={b.variance_pct} alert={b.variance_alert} />,
    },
    {
      key: "total",
      header: "Costo del lote",
      kind: "number",
      cell: (b) => <CostValue cost={b.total_cost} costSource={b.cost_source} />,
    },
    {
      key: "unit",
      header: "Costo por unidad",
      kind: "number",
      cell: (b) => <CostValue cost={b.unit_cost} costSource={b.cost_source} />,
    },
    {
      key: "expiry",
      header: "Vence",
      cell: (b) => (b.expiry_date ? formatBusinessDate(b.expiry_date) : "No vence"),
    },
    { key: "by", header: "Produjo", kind: "secondary", cell: (b) => b.produced_by_employee_name },
    {
      key: "state",
      header: "Estado",
      // La palabra del negocio, con su motivo: «Cerrado» solo no dice por qué.
      cell: (b) =>
        b.closed_at ? (
          <span className="text-muted-foreground">
            Cerrado{b.closed_reason ? ` — ${b.closed_reason}` : ""}
          </span>
        ) : (
          "Abierto"
        ),
      cellTitle: (b) => (b.closed_at ? `Cerrado el ${b.closed_at}` : undefined),
    },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Lotes de «{preparation.name}»</DialogTitle>
        </DialogHeader>

        {batchesQuery.isError ? (
          <EmptyState
            role="alert"
            reason="error"
            title="No se pudieron cargar los lotes"
            description={errorMessage(batchesQuery.error)}
            action={{ label: "Reintentar", onClick: () => void batchesQuery.refetch() }}
          />
        ) : (
          <DenseTable
            caption={`Lotes producidos de ${preparation.name}`}
            columns={columns}
            rows={batches}
            rowKey={(b) => String(b.id)}
            // La franja deja ver la forma del problema sin leer la fila: un
            // lote que se apartó más de 15 % de lo esperado.
            rowStatus={(b) => (b.variance_alert ? "critical" : "none")}
            rowInactive={(b) => b.closed_at !== null}
            legend={BATCHES_LEGEND}
            maxBodyHeightPx={360}
            className="min-w-0"
            bar={
              <DenseTableBar
                shown={batches.length}
                total={batches.length}
                noun="lotes producidos"
                hidden={
                  batchesQuery.isLoading
                    ? "contando…"
                    : batches.length > 0
                      ? `${abiertos} abiertos, el resto ya cerrados`
                      : undefined
                }
              >
                <CsvExportButton href={prepBatchesCsvUrl(preparation.id)} />
              </DenseTableBar>
            }
            note={
              <>
                Los lotes no se editan desde acá: se crean produciendo en el salón y se cierran solos al
                agotarse o vencer. <b>Cambiar la preparación a «explotada» cierra los abiertos</b> con un ajuste
                de conteo.
              </>
            }
            empty={
              batchesQuery.isLoading ? undefined : (
                <EmptyState
                  reason="dependency"
                  title="Todavía no se produjo ningún lote"
                  description="Producí desde el POS o cocina («Producir») para que aparezca acá. Mientras nadie produzca, esta preparación no tiene stock y se va a negativo al venderla."
                />
              )
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
