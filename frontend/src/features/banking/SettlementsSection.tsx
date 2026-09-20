/**
 * Registrar y conciliar liquidaciones — del datáfono y de plataformas.
 *
 * Hallazgo A-1 del cierre de la fase 3: `POST /admin/reconciliation/card`,
 * `POST .../platform`, `GET .../settlements` y `POST .../{id}/settle` estaban
 * construidos y probados en el backend, y **ninguna pantalla los consumía**.
 * Sin poder registrar una liquidación, `settled` era siempre 0 y todo
 * aparecía como no conciliado: la capacidad «conciliación de datáfono y
 * plataformas» no se podía completar.
 *
 * **Por qué en dos pasos.** La fila de `GET /admin/reconciliation/card`
 * agrupa por día y trae `settlement_ids`, no un `id` — así que el botón
 * «Conciliar» no puede colgar de la fila agrupada sin inventar un id. Cuelga
 * de la liquidación concreta, que es la que esta lista muestra. Es el flujo
 * que el backend ya tenía diseñado; lo que faltaba era la pantalla.
 *
 * Nada de plata se calcula acá: el neto (`net_amount`), el rezago
 * (`lag_days`) y la diferencia los publica el servidor.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import {
  createCardSettlement,
  createPlatformSettlement,
  listCardSettlements,
  listPlatformSettlements,
  settleCardReconciliation,
  settlePlatformSettlement,
  type CardSettlementOut,
  type PlatformSettlementOut,
} from "@/api/banking"
import { listPlatforms } from "@/api/channels"
import { newIdempotencyKey } from "@/api/client"
import { MoneyInput } from "@/components/MoneyInput"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { todayLocal } from "./lib"

type Kind = "card" | "platform"

function StatusBadge({ status }: { status: string }): React.JSX.Element {
  if (status === "matched") return <Badge variant="secondary">Conciliada</Badge>
  if (status === "reversed") return <Badge variant="outline">Reversada</Badge>
  return <Badge>Registrada, sin conciliar</Badge>
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

function RegisterDialog({ storeId, kind, onDone }: { storeId: number; kind: Kind; onDone: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [salesDate, setSalesDate] = useState(todayLocal())
  const [settledDate, setSettledDate] = useState(todayLocal())
  const [platformId, setPlatformId] = useState<string>("")
  const [gross, setGross] = useState<number | null>(null)
  const [commission, setCommission] = useState<number | null>(0)
  const [retention, setRetention] = useState<number | null>(0)
  const [reference, setReference] = useState("")
  const idempotencyKeyRef = useRef(newIdempotencyKey())

  const platforms = useQuery({
    queryKey: ["channels", "platforms", storeId],
    queryFn: () => listPlatforms(storeId, { active: true }),
    enabled: kind === "platform" && open,
  })

  const mutation = useMutation<CardSettlementOut | PlatformSettlementOut>({
    mutationFn: () =>
      kind === "card"
        ? createCardSettlement(
            storeId,
            {
              sales_business_date: salesDate,
              settled_business_date: settledDate,
              gross_amount: gross ?? 0,
              commission_amount: commission ?? 0,
              retention_amount: retention ?? 0,
              reference: reference.trim() === "" ? null : reference.trim(),
            },
            idempotencyKeyRef.current,
          )
        : createPlatformSettlement(
            storeId,
            {
              platform_id: Number(platformId),
              period_from: salesDate,
              period_to: settledDate,
              gross_amount: gross ?? 0,
              commission_amount: commission ?? 0,
              reference: reference.trim() === "" ? null : reference.trim(),
            },
            idempotencyKeyRef.current,
          ),
    onSuccess: () => {
      setOpen(false)
      setGross(null)
      setReference("")
      idempotencyKeyRef.current = newIdempotencyKey()
      onDone()
    },
  })

  const canSubmit =
    gross !== null && gross > 0 && (kind === "card" || platformId !== "") && salesDate !== "" && settledDate !== ""

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" size="sm" />}>Registrar liquidación</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {kind === "card" ? "Registrar liquidación del datáfono" : "Registrar liquidación de plataforma"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {kind === "platform" ? (
            <div className="space-y-1.5">
              <Label htmlFor="settlement-platform">Plataforma</Label>
              <Select value={platformId} onValueChange={(v) => setPlatformId(v ?? "")}>
                <SelectTrigger id="settlement-platform">
                  <SelectValue placeholder="Elegí la plataforma" />
                </SelectTrigger>
                <SelectContent>
                  {(platforms.data ?? []).map((p) => (
                    <SelectItem key={p.id} value={String(p.id)}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="settlement-sales-date">{kind === "card" ? "Fecha de la venta" : "Desde"}</Label>
              <Input id="settlement-sales-date" type="date" value={salesDate} onChange={(e) => setSalesDate(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settlement-settled-date">{kind === "card" ? "Fecha del abono" : "Hasta"}</Label>
              <Input id="settlement-settled-date" type="date" value={settledDate} onChange={(e) => setSettledDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="settlement-gross">Bruto liquidado</Label>
            <MoneyInput id="settlement-gross" value={gross} onChange={setGross} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="settlement-commission">Comisión</Label>
              <MoneyInput id="settlement-commission" value={commission} onChange={setCommission} />
            </div>
            {kind === "card" ? (
              <div className="space-y-1.5">
                <Label htmlFor="settlement-retention">Retenciones</Label>
                <MoneyInput id="settlement-retention" value={retention} onChange={setRetention} />
              </div>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            El neto y el rezago los calcula el servidor a partir de estas cifras: acá no se resta nada.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="settlement-reference">Referencia (opcional)</Label>
            <Input id="settlement-reference" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>

          {mutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <Button type="button" className="w-full" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Guardando…" : "Registrar liquidación"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Conciliar una liquidación concreta
// ---------------------------------------------------------------------------

function SettleButton({ id, kind, onDone }: { id: number; kind: Kind; onDone: () => void }): React.JSX.Element {
  const idempotencyKeyRef = useRef(newIdempotencyKey())
  const mutation = useMutation<unknown>({
    mutationFn: () =>
      kind === "card"
        ? settleCardReconciliation(id, { note: null }, idempotencyKeyRef.current)
        : settlePlatformSettlement(id, { note: null }, idempotencyKeyRef.current),
    onSuccess: () => {
      idempotencyKeyRef.current = newIdempotencyKey()
      onDone()
    },
  })
  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
        {mutation.isPending ? "Conciliando…" : "Conciliar"}
      </Button>
      {mutation.isError ? (
        <span role="alert" className="text-xs text-destructive">
          {errorMessage(mutation.error)}
        </span>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function SettlementsSection({
  storeId,
  kind,
  from,
  to,
}: {
  storeId: number
  kind: Kind
  from: string
  to: string
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const query = useQuery<Array<CardSettlementOut | PlatformSettlementOut>>({
    queryKey: ["banking", "settlements", kind, storeId, from, to],
    queryFn: () =>
      kind === "card" ? listCardSettlements({ storeId, from, to }) : listPlatformSettlements({ storeId, from, to }),
  })

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["banking", "settlements", kind, storeId] })
    void queryClient.invalidateQueries({ queryKey: ["banking", "reconciliation", kind, storeId] })
    void queryClient.invalidateQueries({ queryKey: ["banking", "ledger", storeId] })
  }

  const rows = query.data ?? []

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">
            {kind === "card" ? "Liquidaciones del datáfono" : "Liquidaciones de plataformas"}
          </h2>
          <p className="text-xs text-muted-foreground">
            Lo que el {kind === "card" ? "datáfono" : "operador de la plataforma"} abonó de verdad. Mientras no haya
            ninguna registrada, todo lo de arriba aparece como no conciliado — y eso no significa que falte plata,
            significa que falta el dato.
          </p>
        </div>
        <RegisterDialog storeId={storeId} kind={kind} onDone={refresh} />
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando liquidaciones…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudieron cargar las liquidaciones"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No hay liquidaciones registradas en este período" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{kind === "card" ? "Venta" : "Período"}</TableHead>
                <TableHead>{kind === "card" ? "Abono" : "Hasta"}</TableHead>
                <TableHead>Bruto</TableHead>
                <TableHead>Comisión</TableHead>
                {kind === "card" ? <TableHead>Retenciones</TableHead> : null}
                <TableHead>Neto</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const card = kind === "card" ? (r as CardSettlementOut) : null
                const platform = kind === "platform" ? (r as PlatformSettlementOut) : null
                return (
                  <TableRow key={r.id}>
                    <TableCell>
                      {formatBusinessDate(card ? card.sales_business_date : platform!.period_from)}
                    </TableCell>
                    <TableCell>
                      {formatBusinessDate(card ? card.settled_business_date : platform!.period_to)}
                      {card ? <span className="ml-1 text-xs text-muted-foreground">({card.lag_days} d)</span> : null}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatCOP(r.gross_amount)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOP(r.commission_amount)}</TableCell>
                    {card ? <TableCell className="tabular-nums">{formatCOP(card.retention_amount)}</TableCell> : null}
                    <TableCell className="tabular-nums font-medium">{formatCOP(r.net_amount)}</TableCell>
                    <TableCell>
                      <StatusBadge status={r.status} />
                    </TableCell>
                    <TableCell>
                      {r.status === "recorded" ? <SettleButton id={r.id} kind={kind} onDone={refresh} /> : null}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  )
}

export default SettlementsSection
