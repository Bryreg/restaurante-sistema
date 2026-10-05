import { useQuery } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import { getEmployeeRecord, type RecordAttendanceOut, type RecordShiftRowOut } from "@/api/panel"
import { getEmployeeActivity } from "@/api/shifts"
import { useStoreSelection } from "@/app/storeContext"
import { PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { HorarioGantt, ResumenLateral, type FilaHorario, type RenglonResumen } from "@/components/charts"
import { Diferencia } from "@/components/Diferencia"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatBusinessDate, formatClockTime, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatDuracion, formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { ATTENDANCE_NOTE, DISCOUNT_COLUMNS, VOID_COLUMNS, attendanceColumns } from "./columnas"
import { iniciales } from "../lib"
import { AvatarFicha, DetallePlegable, FilaDeTarjetas, PreguntaFicha, SeccionFicha } from "./comun"
import { fichaTurnoHref } from "./rutas"
import { CsvExportButton } from "@/components/CsvExportButton"
import { csvUrl } from "@/api/client"

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

/** Días del gantt de asistencia (handoff: 12). */
const DIAS_GANTT = 12

/** Los `n` días calendario que terminan en `hasta` (ISO), del más reciente al más viejo. Calendario puro. */
function diasHacia(hasta: string, n: number): string[] {
  const [y, m, d] = hasta.split("-").map(Number)
  const base = Date.UTC(y!, (m ?? 1) - 1, d ?? 1)
  const dos = (x: number): string => String(x).padStart(2, "0")
  return Array.from({ length: n }, (_, i) => {
    const f = new Date(base - i * 86_400_000)
    return `${f.getUTCFullYear()}-${dos(f.getUTCMonth() + 1)}-${dos(f.getUTCDate())}`
  })
}

/** «sáb 27»: el día sin el mes, para el rótulo de cada fila. */
function diaCorto(iso: string): string {
  return formatFechaCorta(iso).split(" ").slice(0, 2).join(" ")
}

/**
 * «¿Llega y sale a su hora?» (handoff, ficha de persona): una fila por cada
 * uno de los últimos 12 días del período, con lo que trabajó. **El sistema no
 * tiene horario programado**, así que no hay recuadro punteado ni tramo de
 * tardanza que dibujar: la sección lo dice en vez de inventarlo. La duración
 * de cada día la manda el servidor (motor de nómina).
 */
function Asistencia12Dias({ asistencia, hasta }: { asistencia: RecordAttendanceOut[]; hasta: string }): React.JSX.Element {
  const dias = diasHacia(hasta, DIAS_GANTT)
  const porDia = new Map<string, RecordAttendanceOut[]>()
  for (const a of asistencia) {
    if (!a.business_date) continue
    porDia.set(a.business_date, [...(porDia.get(a.business_date) ?? []), a])
  }
  const filas: FilaHorario[] = dias.map((dia) => {
    const entradas = porDia.get(dia) ?? []
    const [una] = entradas
    const detalle =
      entradas.length === 0
        ? "Sin entrada"
        : entradas.length > 1
          ? `${entradas.length} entradas`
          : una!.status === "open"
            ? "en turno"
            : una!.status === "review"
              ? `entró ${formatClockTime(una!.in_at)} · salida sin marcar`
              : una!.worked_minutes === null || una!.worked_minutes === undefined
                ? undefined
                : formatDuracion(una!.worked_minutes)
    return {
      key: dia,
      etiqueta: diaCorto(dia),
      detalle,
      // Una salida olvidada no tiene hasta dónde dibujarse: estirarla hasta
      // «ahora» inventaría horas. Se dice en el renglón y no se dibuja.
      tramos: entradas
        .filter((a) => a.status !== "review")
        .map((a) => ({ entrada: a.in_at, salida: a.out_at })),
    }
  })
  // Contar filas, no sumar horas: cuántos días tuvo entrada y cuántas
  // salidas quedaron sin marcar.
  const conEntrada = dias.filter((d) => (porDia.get(d) ?? []).length > 0).length
  const olvidadas = dias.flatMap((d) => porDia.get(d) ?? []).filter((a) => a.status === "review").length
  const resumen: RenglonResumen[] = [
    {
      titulo: `${conEntrada} de ${DIAS_GANTT} días con entrada`,
      detalle: conEntrada === 0 ? "No marcó entrada en estos días." : "La entrada la marca su primer PIN del día.",
      tono: "data",
    },
    olvidadas > 0
      ? {
          titulo: `${olvidadas} ${olvidadas === 1 ? "salida sin marcar" : "salidas sin marcar"}`,
          detalle: "No suman horas hasta que se corrijan en Nómina › Horas.",
          tono: "warning",
        }
      : { titulo: "Nunca olvidó marcar salida", detalle: "Todas sus entradas de estos días tienen salida.", tono: "success" },
    {
      titulo: "Sin horario programado",
      detalle: "El sistema no guarda turnos programados: se muestra sólo lo que trabajó, y sin horario no se puede decir si llegó tarde.",
      tono: "muted",
    },
  ]
  return (
    <PreguntaFicha titulo="¿Llega y sale a su hora?">
      <div className="flex min-w-0 flex-col rounded-lg border bg-card md:flex-row">
        <div className="min-w-0 flex-1 p-4">
          <HorarioGantt variante="persona" filas={filas} ahora={new Date().toISOString()} />
        </div>
        <ResumenLateral rotulo={`Últimos ${DIAS_GANTT} días`} renglones={resumen} />
      </div>
    </PreguntaFicha>
  )
}

/**
 * **Ficha de una persona** (handoff del panel, pantalla 10 · persona) en la
 * sede activa y un período (30 días si no se elige): cabecera con avatar,
 * cuatro tarjetas —lo que cobró con la misma cuenta que Informes › Por
 * persona, su ticket, los turnos en que tuvo la caja y la racha de cierres
 * con diferencia (la misma regla que el aviso de Hoy)—, su asistencia de los
 * últimos 12 días como barras de horario y, plegado, las tablas: turnos con
 * la caja, asistencia, anulaciones, descuentos y cortesías, autorizaciones.
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
  const conCajaAbandonada = r.shifts_as_responsible.some((s) => s.is_stale)

  return (
    <div className="space-y-[18px]">
      <Link
        to="/admin/personal"
        title="Volver a Turnos y personal"
        className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
      >
        <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
        Volver a Turnos y personal
      </Link>
      <div className="flex items-start gap-3.5">
        <AvatarFicha forma="persona" texto={iniciales(r.employee.name)} />
        <PageHeader
          className="min-w-0 flex-1"
          name={r.employee.name}
          actions={
            <CsvExportButton
              href={csvUrl(`/admin/records/employee/${employeeId}`, { store_id: activeStoreId, ...range })}
              label="Descargar la ficha"
            />
          }
          question="Qué hizo esta persona en el período: lo que cobró, los turnos en que tuvo la caja, cuándo trabajó y lo que anuló, descontó o regaló."
          context={[
            { label: ROLE_LABEL[r.role] ?? r.role },
            { label: r.employee.active ? "Activa" : "Inactiva" },
            { label: "Período", value: `${formatBusinessDate(r.date_from)} a ${formatBusinessDate(r.date_to)}` },
          ]}
        />
      </div>

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

      <FilaDeTarjetas>
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
        <StatTile
          label="Turnos con la caja"
          value={String(r.shifts_as_responsible.length)}
          tone={conCajaAbandonada ? "critical" : "default"}
          hint={conCajaAbandonada ? "Uno quedó abandonado: está en el detalle." : undefined}
        />
        {streak === undefined ? (
          <StatTile label="Racha de cierres con diferencia" value={null} nullNote="No se pudo leer la racha." />
        ) : (
          <StatTile label="Racha de cierres con diferencia" value={String(streak)} tone={streak >= 2 ? "warning" : "default"} />
        )}
      </FilaDeTarjetas>

      <Asistencia12Dias asistencia={r.attendance} hasta={r.date_to} />

      <DetallePlegable texto="Ver turnos con la caja, asistencia, correcciones y autorizaciones">
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
        <SeccionFicha
          titulo="Asistencia"
          dice="su asistencia real de cada día, con o sin caja abierta"
          sustantivo="entradas"
          vacio="No figura en ningún turno del período."
          columns={attendanceColumns("turno")}
          rows={r.attendance}
          rowKey={(a) => `${a.business_date ?? ""}-${a.in_at}`}
          ancha
        />
        <p className="text-xs text-muted-foreground lg:col-span-2">{ATTENDANCE_NOTE}</p>
        <SeccionFicha
          titulo="Anulaciones que hizo"
          dice="ítems que anuló, con quién lo autorizó"
          sustantivo="anulaciones"
          vacio="No anuló nada en el período."
          columns={VOID_COLUMNS}
          rows={r.voids}
          rowKey={(v) => `${v.order_id}-${v.item_name}-${v.voided_at ?? ""}`}
          ancha
        />
        <SeccionFicha
          titulo="Descuentos que aplicó y cortesías que autorizó"
          dice="lo que se cobró de menos o se regaló con su nombre"
          sustantivo="descuentos y cortesías"
          vacio="Ni descuentos ni cortesías en el período."
          columns={DISCOUNT_COLUMNS}
          rows={r.discounts}
          rowKey={(d) => `${d.kind}-${d.order_id}-${d.at ?? ""}`}
          ancha
        />
      </DetallePlegable>
    </div>
  )
}

export default FichaPersona
