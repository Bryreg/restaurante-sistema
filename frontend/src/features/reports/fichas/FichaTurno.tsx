import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import {
  getShiftRecord,
  type RecordAreaCountOut,
  type RecordEnvelopeOut,
  type RecordNoveltyOut,
  type RecordReserveMovementOut,
} from "@/api/panel"
import {
  getShiftSummary,
  type AdminShiftListItem,
  type CashMovement,
  type CashPickup,
  type Handover,
  type ShiftSummary,
} from "@/api/shifts"
import { PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { Diferencia } from "@/components/Diferencia"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { areaCountHref } from "@/features/inventory/areaCountLib"
import { CAUSE_LABEL } from "@/features/shifts/MovementsPanel"
import { ShiftDetailDialog } from "@/features/shifts/admin/ShiftDetailDialog"

import { ATTENDANCE_NOTE, DISCOUNT_COLUMNS, VOID_COLUMNS, attendanceColumns } from "./columnas"
import { PersonaLink, SeccionFicha } from "./comun"
import { fichaTurnoHref } from "./rutas"

const PICKUP_COLUMNS: readonly DenseColumn<CashPickup>[] = [
  { key: "at", header: "Cuándo", cell: (p) => formatInstant(p.at) },
  { key: "amount", header: "Retiro", kind: "number", cell: (p) => formatCOP(p.amount) },
  { key: "auth", header: "Autorizó", cell: (p) => p.authorized_by_employee_name ?? "—" },
  { key: "env", header: "Sobre", cell: (p) => p.envelope_ref ?? "—" },
  { key: "rev", header: "Estado", cell: (p) => (p.reversed_at ? `Reversado: ${p.reversed_reason ?? ""}` : "Vigente") },
]

const MOVEMENT_COLUMNS: readonly DenseColumn<CashMovement>[] = [
  { key: "at", header: "Cuándo", cell: (m) => formatInstant(m.at) },
  { key: "kind", header: "Tipo", cell: (m) => (m.kind === "income" ? "Ingreso" : "Egreso") },
  { key: "cause", header: "Causa", cell: (m) => (m.cause ? CAUSE_LABEL[m.cause] : "—") },
  { key: "amount", header: "Monto", kind: "number", cell: (m) => formatCOP(m.amount) },
  { key: "who", header: "Quién", cell: (m) => m.employee_name ?? "—" },
]

const ENVELOPE_COLUMNS: readonly DenseColumn<RecordEnvelopeOut>[] = [
  {
    key: "day",
    header: "Sobre del día",
    kind: "name",
    cell: (e) =>
      e.source_shift_id !== null ? (
        <Link to={fichaTurnoHref(e.source_shift_id)} className="text-primary hover:underline">
          {formatBusinessDate(e.business_date)} · turno #{e.source_shift_id}
        </Link>
      ) : (
        formatBusinessDate(e.business_date)
      ),
  },
  { key: "expected", header: "Esperado", kind: "number", cell: (e) => formatCOP(e.expected) },
  { key: "counted", header: "Contado", kind: "number", cell: (e) => formatCOP(e.counted) },
  {
    key: "diff",
    header: "Diferencia",
    kind: "number",
    cell: (e) => <Diferencia valor={e.difference} motivoSinDato="sin conteo" />,
  },
]

const RESERVE_KIND: Record<string, string> = { take: "Tomó de la base", return: "Devolvió a la base" }

const RESERVE_COLUMNS: readonly DenseColumn<RecordReserveMovementOut>[] = [
  { key: "at", header: "Cuándo", cell: (m) => formatInstant(m.at) },
  { key: "kind", header: "Movimiento", cell: (m) => (RESERVE_KIND[m.kind] ?? m.kind) + (m.reversed ? " (reversado)" : "") },
  { key: "amount", header: "Monto", kind: "number", cell: (m) => formatCOP(m.amount) },
  { key: "who", header: "Quién", cell: (m) => m.employee_name },
  { key: "auth", header: "Autorizó", cell: (m) => m.authorized_by ?? "—" },
]

const HANDOVER_KIND: Record<string, string> = { handover: "Relevo", spot_check: "Arqueo sorpresa" }

const HANDOVER_COLUMNS: readonly DenseColumn<Handover>[] = [
  { key: "at", header: "Cuándo", cell: (h) => formatInstant(h.at) },
  { key: "kind", header: "Tipo", cell: (h) => (h.kind ? (HANDOVER_KIND[h.kind] ?? h.kind) : "—") },
  {
    key: "from",
    header: "Entregó",
    cell: (h) => (h.from_responsible ? <PersonaLink id={h.from_responsible.id} name={h.from_responsible.name ?? "—"} /> : "—"),
  },
  {
    key: "to",
    header: "Recibió",
    cell: (h) => (h.new_responsible ? <PersonaLink id={h.new_responsible.id} name={h.new_responsible.name ?? "—"} /> : "—"),
  },
  { key: "counted", header: "Contado", kind: "number", cell: (h) => formatCOP(h.counted_cash) },
]

const NOVELTY_COLUMNS: readonly DenseColumn<RecordNoveltyOut>[] = [
  { key: "title", header: "Novedad", kind: "name", cell: (n) => n.title },
  { key: "who", header: "Quién", cell: (n) => n.employee_name },
  { key: "at", header: "Cuándo", cell: (n) => formatInstant(n.created_at) },
  { key: "state", header: "Estado", cell: (n) => (n.resolved_at ? "Resuelta" : "Sin resolver") },
]

const MOMENT_LABEL: Record<string, string> = { opening: "Apertura", closing: "Cierre", spot: "Recuento" }

const AREA_COLUMNS: readonly DenseColumn<RecordAreaCountOut>[] = [
  {
    key: "area",
    header: "Área",
    kind: "name",
    cell: (c) => (
      <Link to={areaCountHref(c.count_id)} className="text-primary hover:underline">
        {c.area_name}
      </Link>
    ),
  },
  { key: "moment", header: "Momento", cell: (c) => MOMENT_LABEL[c.moment] ?? c.moment },
  { key: "who", header: "Contó", cell: (c) => c.employee_name },
  { key: "at", header: "Cuándo", cell: (c) => formatInstant(c.counted_at) },
]

/** La fila de la lista de turnos que el diálogo de rescates necesita, armada del resumen. */
function asListItem(summary: ShiftSummary, isStale: boolean, storeId: number, responsibleActive: boolean): AdminShiftListItem {
  return {
    id: summary.id,
    business_date: summary.business_date,
    store_id: storeId,
    status: summary.status,
    opened_at: summary.opened_at,
    closed_at: summary.closed_at,
    cash_responsible: summary.cash_responsible,
    cash_responsible_active: responsibleActive,
    expected_cash: summary.expected_cash,
    counted_cash: summary.counted_cash,
    difference: summary.difference,
    is_stale: isStale,
    reviewed_at: summary.reviewed_at,
  }
}

/**
 * **Ficha del turno**: todo lo que se relaciona con un turno en una sola
 * pantalla —su plata (esperado, contado, diferencia, retiros, movimientos,
 * relevos, consignado), sus ventas, sus anulaciones, descuentos y
 * cortesías, sus novedades, los conteos por área hechos mientras estuvo
 * abierto y quién trabajó—, con enlaces a la ficha de cada persona y a cada
 * conteo. Los rescates de administrador (cierre administrativo, reabrir,
 * cancelar, ajustar apertura) y la revisión se abren desde acá con el mismo
 * diálogo de Dinero.
 *
 * Nada se calcula acá: la plata la trae `GET /shifts/{id}` y el resto
 * `GET /admin/records/shift/{id}`.
 */
export function FichaTurno(): React.JSX.Element {
  const { shiftId: raw } = useParams()
  const shiftId = Number(raw)
  const valido = Number.isInteger(shiftId) && shiftId > 0
  const queryClient = useQueryClient()
  const [rescates, setRescates] = useState(false)

  const record = useQuery({
    queryKey: ["admin-record-shift", shiftId],
    queryFn: () => getShiftRecord(shiftId),
    enabled: valido,
  })
  const summary = useQuery({
    queryKey: ["admin-shift-summary", shiftId],
    queryFn: () => getShiftSummary(shiftId),
    enabled: valido,
  })

  const volver = (
    <Button variant="outline" size="sm" nativeButton={false} title="Volver a Dinero" render={<Link to="/admin/dinero" />}>
      <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
      Volver a Dinero
    </Button>
  )

  if (!valido) {
    return <EmptyState reason="dependency" title="Ese turno no existe" description="La dirección no nombra un turno." />
  }
  if (record.isLoading || summary.isLoading) return <Cargando texto="Cargando la ficha del turno…" />
  if (record.isError || summary.isError || !record.data || !summary.data) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar la ficha del turno"
        description={errorMessage(record.error ?? summary.error)}
        action={{
          label: "Reintentar",
          onClick: () => {
            void record.refetch()
            void summary.refetch()
          },
        }}
      />
    )
  }

  const r = record.data
  const s = summary.data
  const abierto = r.status === "open"
  const estado = r.is_stale ? "Abandonado" : abierto ? "Abierto" : "Cerrado"

  return (
    <div className="space-y-5">
      <PageHeader
        name={`Turno #${r.shift_id}`}
        question="Todo lo que se relaciona con este turno: su plata, sus ventas, lo que se anuló o regaló, las novedades, los conteos y quién trabajó."
        context={[
          { label: "Sede", value: r.store_name },
          { label: "Día operativo", value: formatBusinessDate(r.business_date) },
          { label: "Estado", value: estado },
          { label: "Responsable", value: <PersonaLink id={r.responsible.id} name={r.responsible.name} active={r.responsible.active} /> },
        ]}
        actions={
          <>
            {volver}
            <Button type="button" size="sm" onClick={() => setRescates(true)} title="Rescates y revisión">
              Rescates y revisión
            </Button>
          </>
        }
      />

      {r.is_stale ? (
        <p role="status" className="rounded-lg border border-destructive/30 border-l-[3px] border-l-destructive bg-destructive/5 px-3 py-2 text-sm">
          Este turno pasó la hora de corte del día siguiente y nadie lo cerró. No bloquea la venta, pero su plata no
          se cuadró: cerralo con el cierre administrativo desde «Rescates y revisión».
          {!r.responsible.active ? ` Su responsable, ${r.responsible.name}, ya no está activo.` : ""}
        </p>
      ) : null}

      {/* Una cifra por tarjeta, cada una con su procedencia. Abierto, lo que
          manda es el esperado; cerrado, la diferencia. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {r.sales ? (
          <StatTile
            label="Ventas netas del turno"
            value={formatCOP(r.sales.net)}
            hint={`${r.sales.orders ?? 0} comanda${r.sales.orders === 1 ? "" : "s"} · sin impuesto ni propina`}
          />
        ) : (
          <StatTile label="Ventas netas del turno" value={null} nullNote="El turno no cobró ninguna comanda." />
        )}
        <StatTile
          label={abierto ? "Efectivo esperado ahora" : "Efectivo esperado al cierre"}
          {...(s.expected_cash === null || s.expected_cash === undefined
            ? { value: null, nullNote: "El cierre no dejó un esperado." }
            : { value: formatCOP(s.expected_cash) })}
          hint={`Base ${formatCOP(s.opening_cash_total)}`}
        />
        {abierto ? (
          <StatTile label="Contado" value={null} nullNote="Un turno abierto todavía no se contó." />
        ) : (
          <StatTile
            label="Contado"
            {...(s.counted_cash === null || s.counted_cash === undefined
              ? { value: null, nullNote: s.closed_without_count ? "Se cerró sin conteo." : "Sin conteo de cierre." }
              : { value: formatCOP(s.counted_cash) })}
          />
        )}
        <div className="rounded-lg border border-l-[3px] border-l-border p-4">
          <p className="text-sm text-muted-foreground">Diferencia</p>
          <p className="mt-1 text-xl font-semibold">
            <Diferencia valor={s.difference} motivoSinDato={abierto ? "el turno sigue abierto" : "sin conteo de cierre"} />
          </p>
          {r.deposit ? (
            <p className="mt-1 text-xs text-muted-foreground">
              Consignado {formatCOP(r.deposit.deposited_total)}
              {r.deposit.outstanding !== null ? ` · falta ${formatCOP(r.deposit.outstanding)}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {r.opening_count ? (
        <SeccionFicha
          titulo="Apertura por sobres"
          dice={`contó ${r.opening_count.counted_by} a ciegas, sobre por sobre · esperado ${formatCOP(r.opening_count.expected_total)} · contado ${formatCOP(r.opening_count.counted_total)}`}
          sustantivo="sobres"
          vacio="La apertura no llevó sobres."
          columns={ENVELOPE_COLUMNS}
          rows={r.opening_count.envelopes}
          rowKey={(e) => `${e.source_shift_id ?? "?"}-${e.business_date ?? ""}`}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {r.opening_mode === "envelopes"
            ? "Abrió con la regla de sobres, pero no hay un conteo de apertura sellado."
            : `Abrió con base fija de ${formatCOP(s.opening_cash_total)}.`}
        </p>
      )}
      {r.reserve_loan_outstanding !== null || r.reserve_movements.length > 0 ? (
        <SeccionFicha
          titulo="Base de respaldo"
          dice={
            r.reserve_loan_outstanding !== null && r.reserve_loan_outstanding > 0
              ? `el cajón le debe ${formatCOP(r.reserve_loan_outstanding)} a la base`
              : "lo que el cajón tomó y devolvió de la base"
          }
          sustantivo="movimientos de la base"
          vacio="El cajón no tomó nada de la base."
          columns={RESERVE_COLUMNS}
          rows={r.reserve_movements}
          rowKey={(m) => `${m.kind}-${m.at}`}
        />
      ) : null}
      <SeccionFicha
        titulo="Retiros"
        dice="plata que salió del cajón a la mano del dueño"
        sustantivo="retiros"
        vacio="No hubo retiros en este turno."
        columns={PICKUP_COLUMNS}
        rows={s.pickups ?? []}
        rowKey={(p) => String(p.id)}
      />
      <SeccionFicha
        titulo="Movimientos de caja"
        dice="ingresos y egresos con su causa"
        sustantivo="movimientos"
        vacio="No hubo ingresos ni egresos de caja."
        columns={MOVEMENT_COLUMNS}
        rows={s.movements ?? []}
        rowKey={(m) => String(m.id)}
      />
      <SeccionFicha
        titulo="Relevos y arqueos"
        dice="quién entregó el cajón a quién, y lo contado"
        sustantivo="relevos"
        vacio="Nadie relevó la caja en este turno."
        columns={HANDOVER_COLUMNS}
        rows={s.handovers ?? []}
        rowKey={(h) => String(h.id)}
      />
      <SeccionFicha
        titulo="Anulaciones"
        dice="lo que se vendió y se anuló, con quién lo autorizó"
        sustantivo="anulaciones"
        vacio="No se anuló nada en este turno."
        columns={VOID_COLUMNS}
        rows={r.voids}
        rowKey={(v) => `${v.order_id}-${v.item_name}-${v.voided_at ?? ""}`}
      />
      <SeccionFicha
        titulo="Descuentos y cortesías"
        dice="lo que se cobró de menos o se regaló"
        sustantivo="descuentos y cortesías"
        vacio="No hubo descuentos ni cortesías."
        columns={DISCOUNT_COLUMNS}
        rows={r.discounts}
        rowKey={(d) => `${d.kind}-${d.order_id}-${d.at ?? ""}`}
      />
      <SeccionFicha
        titulo="Novedades"
        dice="lo que el salón registró durante el turno"
        sustantivo="novedades"
        vacio="Nadie registró novedades en este turno."
        columns={NOVELTY_COLUMNS}
        rows={r.novelties}
        rowKey={(n) => String(n.id)}
      />
      <SeccionFicha
        titulo="Conteos por área"
        dice="los que se hicieron mientras el turno estuvo abierto"
        sustantivo="conteos"
        vacio="No se hizo ningún conteo por área mientras el turno estuvo abierto."
        columns={AREA_COLUMNS}
        rows={r.area_counts}
        rowKey={(c) => String(c.count_id)}
      />
      <SeccionFicha
        titulo="Asistencia"
        dice="quién estuvo en este turno (la asistencia del día sobre la ventana del turno)"
        sustantivo="entradas"
        vacio="Nadie quedó registrado en el turno."
        columns={attendanceColumns("persona")}
        rows={r.attendance}
        rowKey={(a) => `${a.employee_id}-${a.in_at}`}
      />
      <p className="text-xs text-muted-foreground">{ATTENDANCE_NOTE}</p>

      {rescates ? (
        <ShiftDetailDialog
          shift={asListItem(s, r.is_stale, r.store_id, r.responsible.active)}
          open
          onOpenChange={(open) => {
            if (!open) setRescates(false)
          }}
          onChanged={() => {
            void queryClient.invalidateQueries({ queryKey: ["admin-record-shift", shiftId] })
            void queryClient.invalidateQueries({ queryKey: ["admin-shift-summary", shiftId] })
            void queryClient.invalidateQueries({ queryKey: ["admin-today"] })
            void queryClient.invalidateQueries({ queryKey: ["admin-panel"] })
          }}
        />
      ) : null}
    </div>
  )
}

export default FichaTurno
