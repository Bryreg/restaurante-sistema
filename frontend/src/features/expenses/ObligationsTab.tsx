/**
 * Admin → Obligaciones y gastos → Obligaciones agendadas (T2,
 * `GET`/`POST /admin/obligations`, `POST /admin/obligations/{id}/settle`):
 * arriendo, servicios, impuestos, con su vencimiento y su estado.
 *
 * `status` es `"pending" | "paid"` (`app/expenses/schemas.py::
 * ObligationStatusLiteral`, verificado por lectura directa, no adivinado):
 * no existe un tercer estado "cancelada" — una obligación cancelada sigue
 * `pending` y lleva `cancelled_at` propio, que esta pantalla muestra aparte.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  createObligation,
  getObligations,
  settleObligation,
  type ObligationCategory,
  type ObligationOut,
  type ObligationStatus,
} from "@/api/expenses"
import {
  DenseTable,
  DenseTableBar,
  FilterEmptyState,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"

/** La leyenda del pie: gasto ≠ obligación, vencida ≠ cancelada. */
const OBLIGATIONS_LEGEND: readonly LegendEntry[] = [
  {
    term: "Obligación",
    meaning: (
      <>
        plata que <b>todavía no salió</b> pero vence. Cuando sale, se salda y pasa a ser un gasto: son dos
        momentos distintos del mismo peso.
      </>
    ),
  },
  {
    term: "Vencida",
    meaning: "pasó su fecha y sigue pendiente. No la cancela nadie por vieja: sigue debiéndose.",
  },
  {
    term: "Cancelada",
    meaning: "se dio de baja con un motivo. No es «pagada»: es que ya no hay que pagarla.",
  },
]
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { MoneyInput } from "@/components/MoneyInput"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { obligationCategoryLabel, obligationStatusLabel, OBLIGATION_CATEGORY_LABEL } from "./lib"

function CreateObligationDialog({
  storeId,
  onCreated,
}: {
  storeId: number
  onCreated: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [description, setDescription] = useState("")
  const [category, setCategory] = useState<ObligationCategory>("other")
  const [dueDate, setDueDate] = useState("")
  const [amount, setAmount] = useState<number | null>(null)

  const mutation = useMutation({
    mutationFn: () =>
      createObligation(storeId, {
        description: description.trim(),
        category,
        due_date: dueDate,
        amount: amount as number,
      }),
    onSuccess: () => {
      setDescription("")
      setAmount(null)
      setOpen(false)
      onCreated()
    },
  })

  const canSubmit = description.trim() !== "" && dueDate.trim() !== "" && amount !== null && amount > 0

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button className="h-11 gap-2" />}>Agendar obligación</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Agendar obligación</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="obligation-description">Descripción</Label>
            <Input
              id="obligation-description"
              className="h-11"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="obligation-category">Categoría</Label>
              <Select value={category} onValueChange={(value) => setCategory(value as ObligationCategory)}>
                <SelectTrigger id="obligation-category" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(OBLIGATION_CATEGORY_LABEL) as ObligationCategory[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {OBLIGATION_CATEGORY_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="obligation-due-date">Vencimiento</Label>
              <Input
                id="obligation-due-date"
                type="date"
                className="h-11"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="obligation-amount">Monto</Label>
            <MoneyInput id="obligation-amount" value={amount} onChange={setAmount} />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button
            type="button"
            className="w-full"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Guardar obligación
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SettleAction({
  obligation,
  onSettled,
}: {
  obligation: ObligationOut
  onSettled: () => void
}): React.JSX.Element {
  const mutation = useMutation({
    // `source` siempre "other" desde esta pantalla — "cash_drawer" exige
    // referenciar un `cash_movement_id` que ya exista, y esta pantalla no
    // tiene forma de elegir uno (gap declarado en el entregable).
    mutationFn: () => settleObligation(obligation.id, { source: "other" }, newIdempotencyKey()),
    onSuccess: onSettled,
  })
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        Saldar
      </Button>
      {mutation.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </div>
  )
}

export function ObligationsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [status, setStatus] = useState<ObligationStatus | "all">("all")
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["expenses", "obligations", storeId, status],
    queryFn: () => getObligations({ storeId, status: status === "all" ? undefined : status }),
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["expenses", "obligations"] })
  }

  const rows = query.data ?? []
  const overdue = rows.filter((o) => o.overdue).length

  const columns: readonly DenseColumn<(typeof rows)[number]>[] = [
    {
      key: "description",
      header: "Descripción",
      kind: "name",
      widthPx: 280,
      cell: (o) => <span className="block truncate">{o.description ?? "—"}</span>,
      cellTitle: (o) => o.description ?? undefined,
    },
    { key: "category", header: "Categoría", cell: (o) => obligationCategoryLabel(o.category) },
    {
      key: "due",
      header: "Vencimiento",
      cell: (o) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          {formatBusinessDate(o.due_date)}
          {o.overdue ? (
            <span className="rounded border border-destructive/40 px-1 text-[0.7rem] text-destructive">
              Vencida
            </span>
          ) : null}
        </span>
      ),
    },
    { key: "amount", header: "Monto", kind: "number", cell: (o) => formatCOP(o.amount ?? null) },
    {
      key: "status",
      header: "Estado",
      cell: (o) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <span
            className={
              o.status === "paid"
                ? "size-1.5 rounded-full bg-success"
                : o.overdue
                  ? "size-1.5 rounded-full bg-destructive"
                  : "size-1.5 rounded-full bg-warning"
            }
            aria-hidden="true"
          />
          {obligationStatusLabel(o.status)}
        </span>
      ),
      // Lo cancelado se cuenta en el `title` para no hacer crecer la fila; la
      // fila misma se dibuja apagada.
      cellTitle: (o) =>
        o.cancelled_at
          ? `Cancelada ${formatInstant(o.cancelled_at)}${o.cancelled_reason ? `: ${o.cancelled_reason}` : ""}`
          : undefined,
    },
    {
      key: "action",
      header: "",
      kind: "actions",
      // «Saldar» SÓLO existe si está pendiente y no cancelada: control que
      // aparece y desaparece con el estado de la fila
      // (`docs/INVENTARIO-CONTROLES.md` § 26).
      cell: (o) =>
        o.status === "pending" && !o.cancelled_at ? (
          <SettleAction obligation={o} onSettled={invalidate} />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las obligaciones"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <DenseTable
      caption="Obligaciones agendadas"
      columns={columns}
      rows={rows}
      rowKey={(o) => String(o.id)}
      rowInactive={(o) => Boolean(o.cancelled_at)}
      rowStatus={(o) => (o.overdue ? "critical" : o.status === "pending" ? "warning" : "none")}
      legend={OBLIGATIONS_LEGEND}
      bar={
        <DenseTableBar
          shown={rows.length}
          total={rows.length}
          noun="obligaciones"
          hidden={query.isLoading ? "contando…" : overdue > 0 ? `${overdue} ya vencidas` : undefined}
        >
          <div className="flex items-center gap-2">
            <Label htmlFor="obligation-status-filter">Estado</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as ObligationStatus | "all")}>
              <SelectTrigger id="obligation-status-filter" className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                <SelectItem value="pending">Pendientes</SelectItem>
                <SelectItem value="paid">Pagadas</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <CreateObligationDialog storeId={storeId} onCreated={invalidate} />
        </DenseTableBar>
      }
      empty={
        query.isLoading ? undefined : status !== "all" ? (
          <FilterEmptyState
            title="No hay obligaciones agendadas"
            filters={[status === "pending" ? "pendientes" : "pagadas"]}
            onRemove={() => setStatus("all")}
          />
        ) : (
          <EmptyState
            title="No hay obligaciones agendadas"
            description="Agendá la primera con «Agendar obligación»: el arriendo, los servicios, lo que vence el mes que viene."
          />
        )
      }
    />
  )
}

export default ObligationsTab
