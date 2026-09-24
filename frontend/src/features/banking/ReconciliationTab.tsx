/**
 * Admin → Banco → Conciliación de datáfono / de plataformas (T1,
 * `GET /admin/reconciliation/card` y `.../platform`): lo esperado, lo
 * liquidado y la diferencia — todo calculado por el servidor contra lo que
 * `app/channels/` ya registró como cuenta por cobrar (spec.md § T1). Sólo la
 * conciliación de datáfono ofrece "conciliar" (`POST
 * /admin/reconciliation/card/{id}/settle`, con `Idempotency-Key`): el
 * contrato de esta fase no publica un `settle` para plataformas, así que esa
 * pestaña es de sólo lectura.
 *
 * `CardReconciliationRowOut` (verificado por lectura directa de
 * `app/banking/schemas.py`) agrupa por `business_date` y no lleva `id`
 * propio — sólo `settlement_ids` (las liquidaciones ya registradas que caen
 * en ese día). El contrato mínimo sólo fija la RUTA `.../{id}/settle`, no
 * de dónde sale ese `id`; esta pantalla no inventa uno: oculta "Conciliar"
 * cuando la fila no trae ninguno.
 *
 * **Hallazgo A-1 del cierre, cerrado acá**: no había forma de REGISTRAR una
 * liquidación, así que `settled` era siempre 0 y todo salía como no
 * conciliado. `SettlementsSection` —abajo de la tabla agrupada— registra las
 * liquidaciones y ofrece «Conciliar» sobre cada una, que es donde el `id`
 * existe de verdad. También para plataformas: `POST
 * /admin/reconciliation/platform/{id}/settle` existe desde la construcción de
 * la fase, sólo que el contrato mínimo no lo nombraba.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import { getCardReconciliation, getPlatformReconciliation, settleCardReconciliation, type ReconciliationRowOut } from "@/api/banking"
import { Cargando } from "@/components/Cargando"
import { DenseTable, DenseTableBar, type DenseColumn, type RowStatus } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Diferencia } from "@/components/Diferencia"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { SettlementsSection } from "./SettlementsSection"
import { daysAgoLocal, todayLocal } from "./lib"

function SettleDialog({
  row,
  onSettled,
}: {
  row: ReconciliationRowOut & { id: number }
  onSettled: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState("")
  const idempotencyKeyRef = useRef(newIdempotencyKey())

  const mutation = useMutation({
    mutationFn: () =>
      settleCardReconciliation(row.id, { note: note.trim() === "" ? null : note.trim() }, idempotencyKeyRef.current),
    onSuccess: () => {
      idempotencyKeyRef.current = newIdempotencyKey()
      setOpen(false)
      onSettled()
    },
  })

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Conciliar</DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Conciliar liquidación #{row.id}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Esperado: {formatCOP(row.expected)} · Liquidado: {formatCOP(row.settled)} · Diferencia:{" "}
            <Diferencia valor={row.difference} />
          </p>
          <div className="space-y-1">
            <Label htmlFor="settle-note">Nota (opcional)</Label>
            <Input id="settle-note" className="h-11" value={note} onChange={(event) => setNote(event.target.value)} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="button" className="w-full" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Confirmar conciliación
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** § 8b · Sin conciliar se marca; sin dato de `matched`, no se marca. */
function reconciliationStatus(row: ReconciliationRowOut): RowStatus {
  if (row.matched === undefined) return "none"
  return row.matched ? "ok" : "warning"
}

function reconciliationColumns(
  kind: "card" | "platform",
  settle: (row: ReconciliationRowOut & { id: number }) => React.ReactNode,
): readonly DenseColumn<ReconciliationRowOut>[] {
  const columns: DenseColumn<ReconciliationRowOut>[] = [
    { key: "date", header: "Fecha", kind: "name", cell: (r) => formatBusinessDate(r.business_date) },
  ]
  if (kind === "platform") {
    columns.push({ key: "platform", header: "Plataforma", cell: (r) => r.platform ?? "—" })
  }
  columns.push(
    { key: "expected", header: "Esperado", kind: "number", cell: (r) => formatCOP(r.expected) },
    {
      key: "settled",
      header: "Liquidado",
      kind: "number",
      // Con la columna de plataforma serían seis: «Liquidado» pasa detrás de
      // «Más columnas» (regla 3). La diferencia sigue a la vista.
      secondary: kind === "platform",
      cell: (r) => formatCOP(r.settled),
    },
    { key: "difference", header: "Diferencia", kind: "number", cell: (r) => <Diferencia valor={r.difference} /> },
    {
      key: "status",
      header: "Estado",
      cell: (r) =>
        r.matched === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : r.matched ? (
          <Badge variant="secondary">Conciliado</Badge>
        ) : (
          <Badge variant="destructive">Sin conciliar</Badge>
        ),
    },
  )
  if (kind === "card") {
    columns.push({
      key: "actions",
      header: "Acciones",
      kind: "actions",
      cell: (r) => (!r.matched && r.id !== undefined ? settle({ ...r, id: r.id }) : null),
    })
  }
  return columns
}

export function ReconciliationTab({ storeId, kind }: { storeId: number; kind: "card" | "platform" }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["banking", "reconciliation", kind, storeId, from, to],
    queryFn: () => (kind === "card" ? getCardReconciliation({ storeId, from, to }) : getPlatformReconciliation({ storeId, from, to })),
  })

  const rows = query.data?.rows ?? []

  return (
    <div className="space-y-4">
      <DateRangeFilter idPrefix={`reconciliation-${kind}`} from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to) }} />

      {query.isLoading ? (
        <Cargando texto="Cargando conciliación…" />
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo cargar la conciliación" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="No hay liquidaciones en este período"
          description="Sin liquidaciones registradas no hay contra qué conciliar. Registrá una abajo: eso no significa que falte plata, significa que falta el dato."
        />
      ) : (
        <DenseTable
          caption={
            kind === "card"
              ? "Conciliación de datáfono: esperado, liquidado y diferencia por día."
              : "Conciliación de plataformas: esperado, liquidado y diferencia por día."
          }
          columns={reconciliationColumns(kind, (row) => (
            <SettleDialog
              row={row}
              onSettled={() => void queryClient.invalidateQueries({ queryKey: ["banking", "reconciliation", "card", storeId] })}
            />
          ))}
          rows={rows}
          rowKey={(row) => String(row.id ?? `${row.business_date ?? "sin-fecha"}-${row.platform ?? ""}-${row.expected ?? ""}`)}
          rowStatus={reconciliationStatus}
          maxBodyHeightPx={420}
          bar={
            <DenseTableBar
              shown={rows.length}
              total={rows.length}
              noun={kind === "card" ? "días de datáfono" : "días de plataforma"}
              hidden={`del ${from} al ${to}`}
            />
          }
          legend={[
            {
              term: "Sin conciliar",
              meaning:
                "no quiere decir que falte plata: casi siempre quiere decir que falta registrar la liquidación de abajo.",
            },
            {
              term: "Esperado",
              meaning: "lo que el sistema cobró por ese medio ese día, antes de comisiones.",
            },
            {
              term: "Liquidado",
              meaning: "lo que la liquidación registrada dice que abonaron, ya neto.",
            },
          ]}
        />
      )}

      <SettlementsSection storeId={storeId} kind={kind} from={from} to={to} />
    </div>
  )
}

export default ReconciliationTab
