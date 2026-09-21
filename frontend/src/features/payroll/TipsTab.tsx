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
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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

  return (
    <div className="space-y-2 rounded-lg border p-4">
      <p className="text-sm font-medium">Método de reparto de esta sede</p>
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
    </div>
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
    <div className="space-y-3 rounded-md border p-4">
      <p className="text-sm">
        Vas a registrar quién recibió cuánto y cuándo. El sistema no mueve la plata por vos: esto sólo deja
        constancia — la propina física sigue entregándose por fuera.
      </p>
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
  )
}

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
          <EmptyState role="alert" title="No se pudo calcular la propuesta" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
        ) : !proposal?.available ? (
          <EmptyState title="Propuesta no disponible" description={proposal?.reason ?? "No hay turnos con propinas en este período."} />
        ) : proposal.rows.length === 0 ? (
          <EmptyState title="No hay propinas para repartir en este período" />
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              Método: <Badge variant="secondary">{tipMethodLabel(proposal.method)}</Badge>
            </p>
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Persona</TableHead>
                    <TableHead>Base</TableHead>
                    <TableHead>Monto propuesto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {proposal.rows.map((row) => (
                    <TableRow key={row.employee_id}>
                      <TableCell>{row.employee_name ?? `#${row.employee_id}`}</TableCell>
                      <TableCell>{row.basis ?? "—"}</TableCell>
                      <TableCell className="tabular-nums font-medium">{formatCOP(row.amount)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={2} className="font-semibold">
                      Total
                    </TableCell>
                    <TableCell className="tabular-nums font-semibold">{formatCOP(proposal.total)}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>

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
