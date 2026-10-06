/**
 * Admin → Nómina y propinas → Propinas repartidas (D-3, spec.md § 1 y § T3):
 * método de reparto por sede, la PROPUESTA de reparto (nueva en esta fase,
 * nunca mueve plata) y su confirmación — que llama a `POST
 * /admin/tips/payouts`, publicado desde 1b-2
 * (`app/shifts/tips.py::register_tip_payout`), no reescrito acá.
 *
 * "Es una propuesta, nunca una transferencia automática" se dice en
 * pantalla, no sólo en el código — es el mandato explícito del contrato de
 * esta fase para `GET /admin/tips/distribution/proposal`.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { newIdempotencyKey } from "@/api/client"
import {
  createTipPayout,
  getTipPayouts,
  getTipsBalance,
  getTipsDistributionProposal,
  getTipsSettings,
  reverseTipPayout,
  updateTipsSettings,
  type TipDistributionMethod,
  type TipPayoutMethod,
  type TipPayoutOut,
  type TipsBalanceOut,
} from "@/api/payroll"
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  FormSection,
  ScopeMarks,
  type DenseColumn,
} from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { StatTile } from "@/components/StatTile"
import { Textarea } from "@/components/ui/textarea"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, nowLocalDatetime, tipMethodLabel, todayLocal } from "./lib"

function TipsSettingsSection({ storeId }: { storeId: number }): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ["payroll", "tips-settings", storeId], queryFn: () => getTipsSettings(storeId) })
  const mutation = useMutation({
    mutationFn: (method: TipDistributionMethod) => updateTipsSettings(storeId, { method }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["payroll", "tips-settings", storeId] }),
  })

  const methodWord =
    query.data?.method === "by_hours"
      ? "por las horas que cada quien trabajó"
      : query.data?.method === "equal_shares"
        ? "en partes iguales entre todos"
        : query.data?.method === "by_area"
          ? "por área, con el reparto que cada área tenga asignado"
          : "con el método que devuelva el servidor"

  return (
    <FormSection
      title="Método de reparto de esta sede"
      governs="Cómo se arma la propuesta de reparto de propinas cada vez que mirás un período en esta pestaña."
      columns="one"
      reading={
        <>
          Hoy la propina de esta sede se propone <b>{methodWord}</b>. Cambiar esto cambia la propuesta de acá en
          adelante; los repartos ya confirmados quedan como están y <b>no se recalculan</b>.
        </>
      }
      doesNotDo="Elegir un método no reparte nada ni le avisa a nadie: sólo decide cómo se calcula la propuesta de arriba."
    >
      <div className="min-w-0 space-y-2">
      {query.isLoading ? (
        <Cargando texto="Cargando…" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : query.data ? (
        <Select
          value={query.data.method}
          onValueChange={(value) => mutation.mutate(value as TipDistributionMethod)}
        >
          <SelectTrigger className="w-64" aria-label="Método de reparto de propinas">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="by_hours">Por horas trabajadas</SelectItem>
            <SelectItem value="equal_shares">Partes iguales</SelectItem>
            <SelectItem value="by_area">Por área</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {/* Sólo el flag: este ajuste cambia la propuesta de ESTA pestaña, y un
          chip «Afecta: Nómina › Propinas» acá apuntaría a sí mismo (§ 10). */}
      <ScopeMarks flag="pos.tips" />
      </div>
    </FormSection>
  )
}

function ConfirmPayoutDialog({
  storeId,
  shiftIds,
  distribution,
  onConfirmed,
}: {
  storeId: number
  shiftIds: number[]
  distribution: { employee_id: number; amount: number }[]
  onConfirmed: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [paidAt, setPaidAt] = useState(nowLocalDatetime)
  const [method, setMethod] = useState<TipPayoutMethod>("cash")
  // A-3: sólo se pregunta cuando el reparto es en efectivo, porque sólo ahí
  // significa algo. Un reparto pagado DEL CAJÓN ya redujo el `to_deposit` de
  // su turno; sin este dato, la mano del dueño restaba esa misma plata otra
  // vez. El default es «de la mano», que es el sesgo que muestra menos plata.
  const [paidFrom, setPaidFrom] = useState<"drawer" | "owner_hand">("owner_hand")

  const mutation = useMutation({
    mutationFn: () =>
      createTipPayout(
        storeId,
        { shift_ids: shiftIds, distribution, paid_at: paidAt, method, paid_from: paidFrom },
        newIdempotencyKey(),
      ),
    onSuccess: () => {
      setOpen(false)
      onConfirmed()
    },
  })

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        Confirmar reparto
      </Button>
    )
  }

  return (
    /* § 11 · Ámbar: esto **cambia otra pantalla** (la mano del dueño) y no
       pierde nada — pero el marco avisa, y el botón sigue siendo azul. */
    <ConsequenceZone
      level="reversible"
      scope="Banco › Mano del dueño"
      explanation={
        <>
          Registrar la entrega <b>no mueve un peso</b>: la propina física se entrega por fuera y esto sólo deja
          constancia de quién recibió cuánto y cuándo. Lo que sí cambia es el saldo de <b>Banco › Mano del dueño</b>,
          y por cuánto depende de la respuesta a «¿de dónde salió la plata?».
        </>
      }
    >
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="tip-payout-paid-at">Fecha y hora de entrega</Label>
          <Input id="tip-payout-paid-at" type="datetime-local" className="h-11" value={paidAt} onChange={(event) => setPaidAt(event.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tip-payout-method">Método</Label>
          <Select value={method} onValueChange={(v) => setMethod((v ?? "cash") as TipPayoutMethod)}>
            <SelectTrigger id="tip-payout-method" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="cash">Efectivo</SelectItem>
              <SelectItem value="card">Datáfono</SelectItem>
              <SelectItem value="transfer">Transferencia</SelectItem>
              <SelectItem value="other">Otro</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      {method === "cash" ? (
        <div className="space-y-1">
          <Label htmlFor="tip-payout-source">¿De dónde salió la plata?</Label>
          <Select value={paidFrom} onValueChange={(v) => setPaidFrom((v ?? "owner_hand") as "drawer" | "owner_hand")}>
            <SelectTrigger id="tip-payout-source" className="h-11 w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="owner_hand">De la plata que tenés en la mano</SelectItem>
              <SelectItem value="drawer">Del cajón</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Si salió del cajón, esa plata ya se descontó al cerrar el turno: decirlo acá es lo que evita que la mano
            del dueño la reste dos veces.
          </p>
          {/* § 10 · El alcance no se recuerda, se dibuja: este campo no cambia
              esta pantalla, cambia otra. */}
          <ScopeMarks affects={[{ screen: "Banco › Mano del dueño", verb: "Cambia" }]} />
        </div>
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={mutation.isPending}>
          Cancelar
        </Button>
        <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          Registrar entrega
        </Button>
      </div>
    </div>
    </ConsequenceZone>
  )
}

/**
 * c3 · ¿Llegó toda la propina a quien la generó? (Ley 1935 de 2018). Las
 * tres cifras y la prueba del «100 % entregado» llegan del servidor
 * (`GET /admin/tips/balance`): esta pantalla no resta nada.
 */
function TipsDeliveredCheck({ balance }: { balance: TipsBalanceOut }): React.JSX.Element {
  if (balance.fully_delivered === null) {
    return (
      <p data-testid="tips-delivered-check" className="text-sm text-muted-foreground">
        No hay turnos cerrados en este período: todavía no hay propina que probar como entregada.
      </p>
    )
  }
  if (balance.fully_delivered) {
    return (
      <p
        data-testid="tips-delivered-check"
        className="rounded-md border border-l-4 border-l-success bg-success/5 p-2 text-sm font-medium"
      >
        <span aria-hidden="true">✓ </span>100 % entregado: toda la propina recogida en este período ya se entregó.
      </p>
    )
  }
  return (
    <p
      data-testid="tips-delivered-check"
      className="rounded-md border border-l-4 border-l-warning bg-warning/5 p-2 text-sm font-medium"
    >
      Falta entregar <b>{formatCOP(balance.pending)}</b> de la propina de este período. La ley pide que llegue
      completa a los trabajadores.
    </p>
  )
}

function TipsBalanceSection({ storeId, from, to }: { storeId: number; from: string; to: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["payroll", "tips-balance", storeId, from, to],
    queryFn: () => getTipsBalance({ storeId, from, to }),
  })

  if (query.isLoading) return <Cargando texto="Cargando lo entregado…" />
  if (query.isError || !query.data) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar lo entregado"
        description={query.isError ? errorMessage(query.error) : undefined}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  const balance = query.data
  return (
    <section aria-label="Propina recogida, entregada y pendiente" className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <StatTile label="Recogida" value={formatCOP(balance.collected)} hint="Toda la propina cobrada en los turnos cerrados del período, por cualquier medio." />
        <StatTile label="Entregada" value={formatCOP(balance.paid)} hint="Lo que los repartos registrados (sin los reversados) le entregaron a esos turnos." />
        <StatTile
          label="Pendiente por repartir"
          value={formatCOP(balance.pending)}
          tone={balance.pending > 0 ? "warning" : "default"}
          hint="Lo que todavía no llegó a los trabajadores."
        />
      </div>
      <TipsDeliveredCheck balance={balance} />
      {balance.overpaid > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          Hay {formatCOP(balance.overpaid)} entregados de más en repartos anteriores a esta validación. Revisalos en
          el historial y reversá el que haya quedado mal.
        </p>
      ) : null}
    </section>
  )
}

function ReversePayoutDialog({
  storeId,
  payout,
  onClose,
}: {
  storeId: number
  payout: TipPayoutOut | null
  onClose: () => void
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [reason, setReason] = useState("")
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const mutation = useMutation({
    mutationFn: () => reverseTipPayout(storeId, (payout as TipPayoutOut).id, { reason: reason.trim() }, idempotencyKey),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["payroll", "tips-payouts"] })
      void queryClient.invalidateQueries({ queryKey: ["payroll", "tips-balance"] })
      setReason("")
      setIdempotencyKey(newIdempotencyKey())
      onClose()
    },
  })
  const canSubmit = reason.trim().length >= 3 && !mutation.isPending

  return (
    <Dialog open={payout !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Reversar reparto</DialogTitle>
        </DialogHeader>
        {payout ? (
          <div className="space-y-3">
            <p className="text-sm">
              Reparto del {formatInstant(payout.paid_at)} por <b>{formatCOP(payout.total_amount)}</b>. Queda en el
              historial marcado como reversado y su plata vuelve a quedar <b>pendiente por repartir</b>. No mueve
              plata: si salió del cajón, ese egreso se reversa aparte, en el turno.
            </p>
            <div className="space-y-1">
              <Label htmlFor="tip-payout-reverse-reason">Motivo</Label>
              <Textarea
                id="tip-payout-reverse-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Por ejemplo: se registró dos veces"
              />
            </div>
            {mutation.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {errorMessage(mutation.error)}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={mutation.isPending}>
                Cancelar
              </Button>
              <Button type="button" variant="destructive" disabled={!canSubmit} onClick={() => mutation.mutate()}>
                Reversar reparto
              </Button>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

const PAYOUT_METHOD_LABEL: Record<string, string> = {
  cash: "Efectivo",
  card: "Datáfono",
  transfer: "Transferencia",
  other: "Otro",
}

function payoutOrigin(p: TipPayoutOut): string {
  if (p.method !== "cash") return "—"
  if (p.paid_from === "drawer") return "Del cajón"
  if (p.paid_from === "owner_hand") return "De la mano"
  return "Sin declarar"
}

function TipPayoutsHistory({ storeId, from, to }: { storeId: number; from: string; to: string }): React.JSX.Element {
  const [reversing, setReversing] = useState<TipPayoutOut | null>(null)
  const query = useQuery({
    queryKey: ["payroll", "tips-payouts", storeId, from, to],
    queryFn: () => getTipPayouts({ storeId, from, to, status: "all" }),
  })
  const rows = query.data ?? []

  const columns: readonly DenseColumn<TipPayoutOut>[] = [
    { key: "paid_at", header: "Entregado", kind: "secondary", cell: (p) => formatInstant(p.paid_at) },
    {
      key: "people",
      header: "A quién",
      kind: "name",
      widthPx: 260,
      cell: (p) => (
        <span className="block truncate">
          {p.distribution.map((d) => `${d.employee_name} ${formatCOP(d.amount)}`).join(" · ")}
        </span>
      ),
      cellTitle: (p) => p.distribution.map((d) => `${d.employee_name} ${formatCOP(d.amount)}`).join(" · "),
    },
    { key: "method", header: "Método", cell: (p) => PAYOUT_METHOD_LABEL[p.method] ?? p.method },
    { key: "origin", header: "Origen", kind: "secondary", cell: payoutOrigin },
    { key: "shifts", header: "Turnos", kind: "secondary", cell: (p) => p.shift_ids.map((id) => `#${id}`).join(", ") },
    { key: "total", header: "Total", kind: "number", cell: (p) => formatCOP(p.total_amount) },
    {
      key: "status",
      header: "Estado",
      cell: (p) =>
        p.reversed_at ? (
          <Badge variant="outline" title={p.reversed_reason ?? undefined}>
            Reversado
          </Badge>
        ) : (
          <Badge variant="secondary">Vivo</Badge>
        ),
      cellTitle: (p) =>
        p.reversed_at
          ? `Reversado el ${formatInstant(p.reversed_at)}${p.reversed_by ? ` por ${p.reversed_by.name}` : ""}: ${p.reversed_reason ?? ""}`
          : undefined,
    },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (p) =>
        p.reversed_at ? null : (
          <Button type="button" variant="outline" size="sm" onClick={() => setReversing(p)}>
            Reversar
          </Button>
        ),
    },
  ]

  if (query.isError) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar el historial de repartos"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <>
      <DenseTable
        caption="Historial de repartos de propina entregados en el período"
        columns={columns}
        rows={rows}
        rowKey={(p) => String(p.id)}
        rowInactive={(p) => p.reversed_at != null}
        maxBodyHeightPx={360}
        bar={
          <DenseTableBar
            shown={rows.length}
            total={rows.length}
            noun="repartos entregados en el período"
            hidden={query.isLoading ? "cargando…" : `del ${from} al ${to}`}
          />
        }
        legend={[
          {
            term: "Reversado",
            meaning: "un reparto cargado por error. Queda acá con su motivo y no cuenta como entregado.",
          },
          {
            term: "Período",
            meaning: "acá manda la fecha de entrega; arriba, la fecha de los turnos cuya propina se reparte.",
          },
        ]}
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              reason="filter"
              title="No hay repartos entregados en este período"
              description={`El filtro puesto es el período: ${from} a ${to}.`}
            />
          )
        }
      />
      <ReversePayoutDialog storeId={storeId} payout={reversing} onClose={() => setReversing(null)} />
    </>
  )
}

const TIP_COLUMNS: readonly DenseColumn<{ employee_id: number; employee_name?: string | null; basis?: string | null; amount: number }>[] = [
  { key: "person", header: "Persona", kind: "name", cell: (r) => r.employee_name ?? `#${r.employee_id}` },
  { key: "basis", header: "Base", kind: "secondary", cell: (r) => r.basis ?? "—" },
  { key: "amount", header: "Monto propuesto", kind: "number", cell: (r) => formatCOP(r.amount) },
]

export function TipsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(7))
  const [to, setTo] = useState(todayLocal())
  const [confirmed, setConfirmed] = useState(false)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["payroll", "tips-proposal", storeId, from, to],
    queryFn: () => getTipsDistributionProposal({ storeId, from, to }),
  })
  // La misma consulta que pinta `TipsBalanceSection` (comparten caché): si
  // el servidor dice que el período ya se entregó completo, no se ofrece
  // confirmar otra vez la misma propina.
  const balance = useQuery({
    queryKey: ["payroll", "tips-balance", storeId, from, to],
    queryFn: () => getTipsBalance({ storeId, from, to }),
  })
  const alreadyDelivered = balance.data?.fully_delivered === true

  const proposal = query.data
  const shiftIds = proposal?.shift_ids ?? []

  const onConfirmed = (): void => {
    setConfirmed(true)
    void queryClient.invalidateQueries({ queryKey: ["payroll", "tips-balance"] })
    void queryClient.invalidateQueries({ queryKey: ["payroll", "tips-payouts"] })
  }

  return (
    <div className="space-y-6">
      {/* Primero la propuesta —lo que se viene a mirar—, y el método de
          reparto, que se elige una vez, al final (mapa de pantallas, regla
          1: la cifra protagonista arriba). */}
      <div className="space-y-3">
        <DateRangeFilter idPrefix="tips-proposal" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to); setConfirmed(false) }} />

        <TipsBalanceSection storeId={storeId} from={from} to={to} />

        <div role="status" className="rounded-md border border-l-4 border-l-warning bg-warning/5 p-3 text-sm">
          Esto es una <strong>propuesta</strong>: todavía no movió ni un peso. Sólo se registra algo cuando se
          confirma la entrega abajo.
        </div>

        {query.isLoading ? (
          <p className="text-sm text-muted-foreground">Calculando la propuesta…</p>
        ) : query.isError ? (
          <EmptyState reason="error" title="No se pudo calcular la propuesta" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
        ) : !proposal?.available ? (
          <EmptyState reason="dependency" title="Propuesta no disponible" description={proposal?.reason ?? "No hay turnos con propinas en este período."} />
        ) : proposal.rows.length === 0 ? (
          <EmptyState
            reason="filter"
            title="No hay propinas para repartir en este período"
            description={`El filtro puesto es el período: ${from} a ${to}. No hubo propina cobrada en ese rango.`}
          />
        ) : (
          <div className="space-y-3">
            {/* Regla 1 · La cifra protagonista: el total a repartir, tal como
                lo manda el servidor (el mismo del pie de la tabla). Neutro y
                no verde: la propina no es venta del restaurante. */}
            <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
              <div>
                <p className="text-[0.7rem] tracking-wider text-muted-foreground uppercase">Propina a repartir</p>
                <p data-testid="tips-total" className="text-4xl leading-none font-bold tracking-tight tabular-nums">
                  {formatCOP(proposal.total)}
                </p>
              </div>
              <p className="text-sm">
                Método: <Badge variant="secondary">{tipMethodLabel(proposal.method)}</Badge>
              </p>
            </div>
            <DenseTable
              caption="Propuesta de reparto de propinas por persona en el período."
              columns={TIP_COLUMNS}
              rows={proposal.rows}
              rowKey={(row) => String(row.employee_id)}
              maxBodyHeightPx={360}
              bar={
                <DenseTableBar
                  shown={proposal.rows.length}
                  total={proposal.rows.length}
                  noun="personas en la propuesta"
                  hidden={`del ${from} al ${to}`}
                />
              }
              footer={
                <tr className="font-bold">
                  <td className="px-2 py-1.5" colSpan={2}>
                    Total
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCOP(proposal.total)}</td>
                </tr>
              }
              legend={[
                {
                  term: "Propuesta ≠ entrega",
                  meaning: "estos montos no se pagaron. Sólo existen como cuenta hasta que se confirme la entrega.",
                },
                {
                  term: "Base",
                  meaning: "sobre qué se repartió a esa persona: sus horas, su parte igual o su área, según el método.",
                },
              ]}
            />

            {confirmed ? (
              <p role="status" className="text-sm font-medium text-success">
                Entrega registrada. Volvé a calcular la propuesta para el próximo período.
              </p>
            ) : alreadyDelivered ? (
              <p className="text-sm text-muted-foreground">
                La propina de este período ya se entregó completa: no hay nada más que confirmar. Si un reparto quedó
                mal, reversalo en el historial de abajo.
              </p>
            ) : shiftIds.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Esta propuesta no informó los turnos que cubre (`shift_ids`): es un gap declarado en el entregable —
                sin esa lista no se puede llamar a «confirmar» sin adivinar qué turnos incluir.
              </p>
            ) : (
              <ConfirmPayoutDialog
                storeId={storeId}
                shiftIds={shiftIds}
                distribution={proposal.rows.map((row) => ({ employee_id: row.employee_id, amount: row.amount }))}
                onConfirmed={onConfirmed}
              />
            )}
          </div>
        )}
      </div>

      <TipPayoutsHistory storeId={storeId} from={from} to={to} />

      <TipsSettingsSection storeId={storeId} />
    </div>
  )
}

export default TipsTab
