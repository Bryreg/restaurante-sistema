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
  getTipsDistributionProposal,
  getTipsSettings,
  updateTipsSettings,
  type TipDistributionMethod,
  type TipPayoutMethod,
} from "@/api/payroll"
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  FormSection,
  ScopeMarks,
  type DenseColumn,
} from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
      doesNotDo="Elegir un método no reparte nada ni le avisa a nadie: sólo decide cómo se calcula la propuesta de abajo."
    >
      <div className="min-w-0 space-y-2">
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
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

const TIP_COLUMNS: readonly DenseColumn<{ employee_id: number; employee_name?: string | null; basis?: string | null; amount: number }>[] = [
  { key: "person", header: "Persona", kind: "name", cell: (r) => r.employee_name ?? `#${r.employee_id}` },
  { key: "basis", header: "Base", kind: "secondary", cell: (r) => r.basis ?? "—" },
  { key: "amount", header: "Monto propuesto", kind: "number", cell: (r) => formatCOP(r.amount) },
]

export function TipsTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(7))
  const [to, setTo] = useState(todayLocal())
  const [confirmed, setConfirmed] = useState(false)

  const query = useQuery({
    queryKey: ["payroll", "tips-proposal", storeId, from, to],
    queryFn: () => getTipsDistributionProposal({ storeId, from, to }),
  })

  const proposal = query.data
  const shiftIds = proposal?.shift_ids ?? []

  return (
    <div className="space-y-4">
      <TipsSettingsSection storeId={storeId} />

      <div className="space-y-3">
        <DateRangeFilter idPrefix="tips-proposal" from={from} to={to} onChange={(r) => { setFrom(r.from); setTo(r.to); setConfirmed(false) }} />

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
            <p className="text-sm">
              Método: <Badge variant="secondary">{tipMethodLabel(proposal.method)}</Badge>
            </p>
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
                onConfirmed={() => setConfirmed(true)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default TipsTab
