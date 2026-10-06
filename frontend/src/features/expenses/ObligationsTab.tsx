/**
 * Admin → Obligaciones y gastos → Obligaciones agendadas (T2,
 * `GET`/`POST /admin/obligations`, `POST /admin/obligations/{id}/payments`):
 * arriendo, servicios, impuestos, nómina e INC agendados, con su
 * vencimiento, lo pagado, lo que falta y su estado.
 *
 * `status` es `"pending" | "partial" | "paid"` (`app/expenses/schemas.py::
 * ObligationStatusLiteral`), derivado de los abonos por el servidor; lo
 * pagado y el saldo también vienen del servidor (c5). No existe un estado
 * "cancelada" — una obligación cancelada lleva `cancelled_at` propio, que
 * esta pantalla muestra aparte.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  addObligationPayment,
  createObligation,
  getDrawerExpenseMovements,
  getObligationPayments,
  getObligations,
  voidObligationPayment,
  type DrawerExpenseMovementOut,
  type ExpenseSource,
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
    term: "Con abonos",
    meaning: "se pagó una parte; «Falta» es lo que queda. Cada abono dice de dónde salió la plata.",
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

import {
  DRAWER_EXPENSE_CAUSE_LABEL,
  EXPENSE_SOURCE_LABEL,
  expenseSourceLabel,
  obligationCategoryLabel,
  obligationStatusLabel,
  OBLIGATION_CATEGORY_LABEL,
} from "./lib"
import { CsvExportButton } from "@/components/CsvExportButton"
import { csvUrl } from "@/api/client"

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

/**
 * Los abonos ya hechos, con «Anular» (con motivo: nada se borra). Se piden
 * sólo con el diálogo abierto.
 */
function PaymentsHistory({
  obligation,
  onChanged,
}: {
  obligation: ObligationOut
  onChanged: () => void
}): React.JSX.Element | null {
  const [voiding, setVoiding] = useState<number | null>(null)
  const [reason, setReason] = useState("")
  const payments = useQuery({
    queryKey: ["expenses", "obligation-payments", obligation.id],
    queryFn: () => getObligationPayments(obligation.id),
  })
  const mutation = useMutation({
    mutationFn: (paymentId: number) =>
      voidObligationPayment(obligation.id, paymentId, reason.trim(), newIdempotencyKey()),
    onSuccess: () => {
      setVoiding(null)
      setReason("")
      void payments.refetch()
      onChanged()
    },
  })
  const rows = payments.data ?? []
  if (payments.isLoading || rows.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-md border p-2">
      <p className="text-xs font-medium text-muted-foreground">Abonos</p>
      <ul className="space-y-1 text-sm">
        {rows.map((p) => (
          <li key={p.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className={p.voided_at ? "text-muted-foreground line-through" : undefined}>
                {formatBusinessDate(p.paid_on)} · {formatCOP(p.amount)} · {expenseSourceLabel(p.source)}
              </span>
              {p.voided_at ? (
                <span className="text-xs text-muted-foreground" title={p.voided_reason ?? undefined}>
                  Anulado
                </span>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={() => setVoiding(p.id)}>
                  Anular abono
                </Button>
              )}
            </div>
            {voiding === p.id ? (
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1">
                  <Label htmlFor={`void-payment-${p.id}`}>Motivo de la anulación</Label>
                  <Input
                    id={`void-payment-${p.id}`}
                    className="h-9"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={reason.trim() === "" || mutation.isPending}
                  onClick={() => mutation.mutate(p.id)}
                >
                  Confirmar anulación
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </div>
  )
}

function PayAction({
  obligation,
  storeId,
  onSettled,
}: {
  obligation: ObligationOut
  storeId: number
  onSettled: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [source, setSource] = useState<ExpenseSource>("bank")
  const [movementId, setMovementId] = useState<string>("")
  // El monto arranca en el SALDO que publica el servidor (nunca una resta
  // hecha acá); se puede bajar para un abono.
  const [amount, setAmount] = useState<number | null>(obligation.pending_amount ?? null)

  // Los egresos del cajón que todavía no respaldan nada: sólo se piden si
  // la plata salió del cajón (el backend exige referenciar uno, nunca crea
  // un egreso nuevo — sería sacar la plata dos veces).
  const movements = useQuery({
    queryKey: ["expenses", "drawer-movements", storeId],
    queryFn: () => getDrawerExpenseMovements(storeId),
    enabled: open && source === "cash_drawer",
  })

  const mutation = useMutation({
    mutationFn: () =>
      addObligationPayment(
        obligation.id,
        {
          amount: amount as number,
          source,
          cash_movement_id: source === "cash_drawer" ? Number(movementId) : null,
        },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      setOpen(false)
      setMovementId("")
      onSettled()
    },
  })

  const canSubmit = amount !== null && amount > 0 && (source !== "cash_drawer" || movementId !== "")
  const movementRows = movements.data ?? []

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setAmount(obligation.pending_amount ?? null)
      }}
    >
      <DialogTrigger render={<Button type="button" variant="outline" size="sm" />}>Pagar</DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Registrar pago</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm">
            {obligation.description ?? "—"} · <b>{formatCOP(obligation.amount ?? null)}</b>
          </p>
          <p className="text-sm text-muted-foreground">
            Pagado {formatCOP(obligation.paid_amount ?? null)} · Falta{" "}
            <b className="text-foreground">{formatCOP(obligation.pending_amount ?? null)}</b>
          </p>
          {open ? <PaymentsHistory obligation={obligation} onChanged={onSettled} /> : null}
          <div className="space-y-1">
            <Label htmlFor={`pay-amount-${obligation.id}`}>Monto de este pago</Label>
            <MoneyInput id={`pay-amount-${obligation.id}`} value={amount} onChange={setAmount} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`settle-source-${obligation.id}`}>¿De dónde salió la plata?</Label>
            <Select
              value={source}
              onValueChange={(value) => {
                setSource(value as ExpenseSource)
                setMovementId("")
              }}
            >
              <SelectTrigger id={`settle-source-${obligation.id}`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(EXPENSE_SOURCE_LABEL) as ExpenseSource[]).map((key) => (
                  <SelectItem key={key} value={key}>
                    {EXPENSE_SOURCE_LABEL[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {source === "cash_drawer" ? (
            <div className="space-y-1">
              <Label htmlFor={`settle-movement-${obligation.id}`}>Egreso del cajón que la pagó</Label>
              {movements.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(movements.error)}
                </p>
              ) : movements.isLoading ? (
                <p className="text-sm text-muted-foreground">Cargando egresos del cajón…</p>
              ) : movementRows.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No hay egresos del cajón sin usar en los últimos 30 días. Registrá primero el egreso en el turno,
                  desde el POS, y volvé a saldarla.
                </p>
              ) : (
                <Select value={movementId || undefined} onValueChange={(value) => setMovementId(String(value ?? ""))}>
                  <SelectTrigger id={`settle-movement-${obligation.id}`} className="w-full">
                    <SelectValue placeholder="Elegí el egreso" />
                  </SelectTrigger>
                  <SelectContent>
                    {movementRows.map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {drawerMovementLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}
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
            Confirmar pago
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function drawerMovementLabel(m: DrawerExpenseMovementOut): string {
  const cause = DRAWER_EXPENSE_CAUSE_LABEL[m.cause] ?? m.cause
  return `${formatInstant(m.at)} · ${cause} · ${formatCOP(m.amount)}${m.note ? ` · ${m.note}` : ""}`
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
      key: "pending",
      header: "Falta",
      kind: "number",
      cell: (o) => formatCOP(o.pending_amount ?? null),
      cellTitle: (o) => (o.paid_amount ? `Pagado: ${formatCOP(o.paid_amount)}` : undefined),
    },
    { key: "paid", header: "Pagado", kind: "number", secondary: true, cell: (o) => formatCOP(o.paid_amount ?? null) },
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
          : o.status === "paid" && o.settled_source
            ? `Pagada desde: ${expenseSourceLabel(o.settled_source)}`
            : undefined,
    },
    {
      key: "action",
      header: "",
      kind: "actions",
      // «Pagar» SÓLO existe si queda saldo y no está cancelada: control que
      // aparece y desaparece con el estado de la fila
      // (`docs/INVENTARIO-CONTROLES.md` § 26).
      cell: (o) =>
        o.status !== "paid" && !o.cancelled_at ? (
          <PayAction obligation={o} storeId={storeId} onSettled={invalidate} />
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
      rowStatus={(o) => (o.overdue ? "critical" : o.status !== "paid" ? "warning" : "none")}
      legend={OBLIGATIONS_LEGEND}
      bar={
        <DenseTableBar
          shown={rows.length}
          total={rows.length}
          noun="obligaciones"
          hidden={query.isLoading ? "contando…" : overdue > 0 ? `${overdue} ya vencidas` : undefined}
        >
          <CsvExportButton
            href={csvUrl("/admin/obligations", { store_id: storeId, status: status === "all" ? undefined : status })}
          />
          <div className="flex items-center gap-2">
            <Label htmlFor="obligation-status-filter">Estado</Label>
            <Select value={status} onValueChange={(value) => setStatus(value as ObligationStatus | "all")}>
              <SelectTrigger id="obligation-status-filter" className="h-8 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas</SelectItem>
                <SelectItem value="pending">Pendientes</SelectItem>
                <SelectItem value="partial">Con abonos</SelectItem>
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
            filters={[status === "pending" ? "pendientes" : status === "partial" ? "con abonos" : "pagadas"]}
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
