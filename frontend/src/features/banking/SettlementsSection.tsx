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
import { Cargando } from "@/components/Cargando"
import { DenseTable, type DenseColumn } from "@/components/admin"
import { MoneyInput } from "@/components/MoneyInput"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { Explicacion } from "./Explicacion"
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

type Settlement = CardSettlementOut | PlatformSettlementOut

function asCard(r: Settlement, kind: Kind): CardSettlementOut | null {
  return kind === "card" ? (r as CardSettlementOut) : null
}

function asPlatform(r: Settlement, kind: Kind): PlatformSettlementOut | null {
  return kind === "platform" ? (r as PlatformSettlementOut) : null
}

function settlementColumns(kind: Kind, action: (r: Settlement) => React.ReactNode): readonly DenseColumn<Settlement>[] {
  const columns: DenseColumn<Settlement>[] = [
    {
      key: "from",
      header: kind === "card" ? "Venta" : "Período",
      kind: "name",
      cell: (r) => formatBusinessDate(asCard(r, kind)?.sales_business_date ?? asPlatform(r, kind)?.period_from),
    },
    {
      key: "to",
      header: kind === "card" ? "Abono" : "Hasta",
      cell: (r) => {
        const card = asCard(r, kind)
        return (
          <>
            {formatBusinessDate(card ? card.settled_business_date : asPlatform(r, kind)?.period_to)}
            {card ? <span className="ml-1 text-xs text-muted-foreground">({card.lag_days} d)</span> : null}
          </>
        )
      },
    },
    { key: "gross", header: "Bruto", kind: "number", secondary: true, cell: (r) => formatCOP(r.gross_amount) },
    { key: "commission", header: "Comisión", kind: "number", secondary: true, cell: (r) => formatCOP(r.commission_amount) },
  ]
  if (kind === "card") {
    columns.push({
      key: "retention",
      header: "Retenciones",
      kind: "number",
      secondary: true,
      cell: (r) => formatCOP(asCard(r, kind)?.retention_amount ?? null),
    })
  }
  columns.push(
    { key: "net", header: "Neto", kind: "number", cell: (r) => <span className="font-medium">{formatCOP(r.net_amount)}</span> },
    { key: "status", header: "Estado", cell: (r) => <StatusBadge status={r.status} /> },
    { key: "actions", header: "Acciones", kind: "actions", cell: action },
  )
  return columns
}

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
  const query = useQuery<Settlement[]>({
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
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">
            {kind === "card" ? "Liquidaciones del datáfono" : "Liquidaciones de plataformas"}
          </h2>
          {/* Regla 2 · El párrafo que explicaba la sección, plegado. */}
          <Explicacion>
            <p>
              Lo que el {kind === "card" ? "datáfono" : "operador de la plataforma"} abonó de verdad. Mientras no haya
              ninguna registrada, todo lo de arriba aparece como no conciliado — y eso no significa que falte plata,
              significa que falta el dato.
            </p>
          </Explicacion>
        </div>
        <RegisterDialog storeId={storeId} kind={kind} onDone={refresh} />
      </div>

      {query.isLoading ? (
        <Cargando texto="Cargando liquidaciones…" />
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
        /* Era una tabla a mano de ocho columnas (siete en plataformas): pasa a
           `DenseTable` con las fechas, el neto y el estado a la vista, y el
           bruto, la comisión y las retenciones detrás de «Más columnas»
           (regla 3). «Conciliar» es la única acción de la fila: queda botón. */
        <DenseTable
          caption={kind === "card" ? "Liquidaciones del datáfono registradas en el período." : "Liquidaciones de plataformas registradas en el período."}
          columns={settlementColumns(kind, (r) =>
            r.status === "recorded" ? <SettleButton id={r.id} kind={kind} onDone={refresh} /> : null,
          )}
          rows={rows}
          rowKey={(r) => String(r.id)}
          rowInactive={(r) => r.status === "reversed"}
          rowStatus={(r) => (r.status === "recorded" ? "warning" : r.status === "matched" ? "ok" : "none")}
          maxBodyHeightPx={360}
        />
      )}
    </section>
  )
}

export default SettlementsSection
