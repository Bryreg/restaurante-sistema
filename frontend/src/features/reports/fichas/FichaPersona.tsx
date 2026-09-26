import { useQuery } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import { getEmployeeRecord, type RecordShiftRowOut } from "@/api/panel"
import { getEmployeeActivity } from "@/api/shifts"
import { useStoreSelection } from "@/app/storeContext"
import { PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { Diferencia } from "@/components/Diferencia"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { ATTENDANCE_NOTE, DISCOUNT_COLUMNS, VOID_COLUMNS, attendanceColumns } from "./columnas"
import { SeccionFicha } from "./comun"
import { fichaTurnoHref } from "./rutas"

const ROLE_LABEL: Record<string, string> = {
  operator: "Operador",
  supervisor: "Supervisor",
  admin: "Administrador",
}

const SHIFT_COLUMNS: readonly DenseColumn<RecordShiftRowOut>[] = [
  {
    key: "shift",
    header: "Turno",
    kind: "name",
    cell: (s) => (
      <Link to={fichaTurnoHref(s.shift_id)} className="text-primary hover:underline">
        #{s.shift_id} · {formatBusinessDate(s.business_date)}
      </Link>
    ),
  },
  {
    key: "status",
    header: "Estado",
    cell: (s) =>
      s.is_stale ? <Badge variant="destructive">Abandonado</Badge> : s.status === "open" ? "Abierto" : "Cerrado",
  },
  {
    key: "diff",
    header: "Diferencia",
    kind: "number",
    cell: (s) => (
      <Diferencia
        valor={s.difference}
        motivoSinDato={s.status === "open" ? "sigue abierto" : s.closed_without_count ? "cerró sin conteo" : "sin conteo"}
      />
    ),
  },
]

/**
 * **Ficha de una persona** en la sede activa y un período (30 días si no se
 * elige): lo que cobró —con la misma cuenta que Informes › Por persona—,
 * los turnos en que tuvo la caja (cada uno lleva a su ficha), su
 * asistencia distinguiendo marcar entrada de sólo identificarse, y sus
 * anulaciones, descuentos y cortesías. La racha de diferencias sale de la
 * misma regla que el aviso de Hoy (`GET /admin/employees/{id}/activity`).
 */
export function FichaPersona(): React.JSX.Element {
  const { employeeId: raw } = useParams()
  const employeeId = Number(raw)
  const valido = Number.isInteger(employeeId) && employeeId > 0
  const { activeStoreId, loading } = useStoreSelection()
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const range = { from: from || undefined, to: to || undefined }

  const record = useQuery({
    queryKey: ["admin-record-employee", employeeId, activeStoreId, from, to],
    queryFn: () => getEmployeeRecord(employeeId, activeStoreId as number, range),
    enabled: valido && activeStoreId !== null,
  })
  const activity = useQuery({
    queryKey: ["admin-employee-activity", employeeId, activeStoreId, from, to],
    queryFn: () => getEmployeeActivity(employeeId, { storeId: activeStoreId ?? undefined, ...range }),
    enabled: valido && activeStoreId !== null,
  })

  if (!valido) {
    return <EmptyState reason="dependency" title="Esa persona no existe" description="La dirección no nombra a una persona." />
  }
  if (loading || record.isLoading) return <Cargando texto="Cargando la ficha…" />
  if (record.isError || !record.data) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar la ficha"
        description={errorMessage(record.error)}
        action={{ label: "Reintentar", onClick: () => void record.refetch() }}
      />
    )
  }

  const r = record.data
  const streak = activity.data?.difference_streak
  const given = activity.data?.authorizations_given ?? []

  return (
    <div className="space-y-5">
      <PageHeader
        name={r.employee.name}
        question="Qué hizo esta persona en el período: lo que cobró, los turnos en que tuvo la caja, cuándo trabajó y lo que anuló, descontó o regaló."
        context={[
          { label: "Rol", value: ROLE_LABEL[r.role] ?? r.role },
          { label: "Estado", value: r.employee.active ? "Activa" : "Inactiva" },
          { label: "Período", value: `${formatBusinessDate(r.date_from)} a ${formatBusinessDate(r.date_to)}` },
        ]}
        actions={
          <Button variant="outline" size="sm" nativeButton={false} title="Volver a Turnos y personal" render={<Link to="/admin/personal" />}>
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            Volver a Turnos y personal
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="ficha-persona-desde">Desde</Label>
          <Input id="ficha-persona-desde" type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ficha-persona-hasta">Hasta</Label>
          <Input id="ficha-persona-hasta" type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      {!r.employee.active ? (
        <p role="status" className="rounded-lg border border-warning/45 border-l-[3px] border-l-warning bg-warning/10 px-3 py-2 text-sm">
          Esta persona está inactiva. Su historia se conserva: nada de lo que hizo se borra.
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {r.charged ? (
          <StatTile
            label="Cobró (ventas netas)"
            value={formatCOP(r.charged.net)}
            hint={`${r.charged.orders ?? 0} comanda${r.charged.orders === 1 ? "" : "s"} · la misma cuenta que Informes › Por persona`}
          />
        ) : (
          <StatTile label="Cobró (ventas netas)" value={null} nullNote="No cobró ninguna comanda en el período." />
        )}
        {r.charged?.avg_ticket === null || r.charged?.avg_ticket === undefined ? (
          <StatTile label="Ticket promedio" value={null} nullNote="Sin comandas cobradas en el período." />
        ) : (
          <StatTile label="Ticket promedio" value={formatCOP(r.charged.avg_ticket)} />
        )}
        <StatTile label="Turnos con la caja" value={String(r.shifts_as_responsible.length)} />
        {streak === undefined ? (
          <StatTile label="Racha de cierres con diferencia" value={null} nullNote="No se pudo leer la racha." />
        ) : (
          <StatTile label="Racha de cierres con diferencia" value={String(streak)} tone={streak >= 2 ? "warning" : "default"} />
        )}
      </div>

      <SeccionFicha
        titulo="Turnos con la caja"
        dice="los turnos en que fue responsable, cada uno con su ficha"
        sustantivo="turnos"
        vacio="No tuvo la caja en el período."
        columns={SHIFT_COLUMNS}
        rows={r.shifts_as_responsible}
        rowKey={(s) => String(s.shift_id)}
      />
      <SeccionFicha
        titulo="Asistencia"
        dice="su asistencia real de cada día, con o sin caja abierta"
        sustantivo="entradas"
        vacio="No figura en ningún turno del período."
        columns={attendanceColumns("turno")}
        rows={r.attendance}
        rowKey={(a) => `${a.business_date ?? ""}-${a.in_at}`}
      />
      <p className="text-xs text-muted-foreground">{ATTENDANCE_NOTE}</p>
      <SeccionFicha
        titulo="Anulaciones que hizo"
        dice="ítems que anuló, con quién lo autorizó"
        sustantivo="anulaciones"
        vacio="No anuló nada en el período."
        columns={VOID_COLUMNS}
        rows={r.voids}
        rowKey={(v) => `${v.order_id}-${v.item_name}-${v.voided_at ?? ""}`}
      />
      <SeccionFicha
        titulo="Descuentos que aplicó y cortesías que autorizó"
        dice="lo que se cobró de menos o se regaló con su nombre"
        sustantivo="descuentos y cortesías"
        vacio="Ni descuentos ni cortesías en el período."
        columns={DISCOUNT_COLUMNS}
        rows={r.discounts}
        rowKey={(d) => `${d.kind}-${d.order_id}-${d.at ?? ""}`}
      />
      <SeccionFicha
        titulo="Autorizaciones que dio"
        dice="lo que habilitó con su PIN para que otro pudiera hacerlo"
        sustantivo="autorizaciones"
        vacio="No dio autorizaciones en el período."
        columns={[
          { key: "action", header: "Acción", kind: "name", cell: (a) => a.action ?? "—" },
          { key: "at", header: "Cuándo", cell: (a) => formatInstant(a.at) },
        ]}
        rows={given}
        rowKey={(a) => `${a.action ?? "?"}-${a.at ?? "?"}`}
      />
    </div>
  )
}

export default FichaPersona
