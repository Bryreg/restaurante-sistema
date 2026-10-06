import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, ArrowRight } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import {
  getShiftRecord,
  type CashByHourSeriesOut,
  type RecordAreaCountOut,
  type RecordAttendanceOut,
  type RecordDiscountOut,
  type RecordEnvelopeOut,
  type RecordNoveltyOut,
  type RecordReserveMovementOut,
  type RecordVoidOut,
  type ShiftRecordOut,
} from "@/api/panel"
import {
  getShiftSummary,
  type AdminShiftListItem,
  type CashMovement,
  type CashPickup,
  type Handover,
  type ShiftSummary,
} from "@/api/shifts"
import { HeadlineFigure, PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { BarrasConReferencia, HorarioGantt, type FilaHorario, type RenglonResumen } from "@/components/charts"
import { Diferencia } from "@/components/Diferencia"
import { SinDato } from "@/components/SinDato"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { formatBusinessDate, formatClockTime, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatDuracion, formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { areaCountHref } from "@/features/inventory/areaCountLib"
import { COURTESY_REASON_LABEL, DISCOUNT_REASON_LABEL, VOID_REASON_LABEL } from "@/features/orders/lib"
import { CAUSE_LABEL } from "@/features/shifts/MovementsPanel"
import { ShiftRescuesDialog } from "@/features/shifts/admin/rescates"

import { weekdayName } from "../lib"
import { ATTENDANCE_NOTE, attendanceColumns } from "./columnas"
import { DetallePlegable, PersonaLink, PreguntaFicha, SeccionFicha } from "./comun"
import { fichaPersonaHref, fichaTurnoHref } from "./rutas"

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
  {
    key: "diff",
    header: "Diferencia",
    kind: "number",
    cell: (h) => <Diferencia valor={h.breakdown?.difference} motivoSinDato="sin esperado congelado" />,
  },
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

/**
 * Anulaciones, descuentos y cortesías en una sola lista («correcciones» del
 * handoff): se juntan filas que ya llegaron, cada una con su monto tal como
 * lo mandó el servidor. Nada se suma.
 */
type Correccion =
  | { tipo: "void"; clave: string; at: string | null; fila: RecordVoidOut }
  | { tipo: "discount"; clave: string; at: string | null; fila: RecordDiscountOut }

const CORRECTION_COLUMNS: readonly DenseColumn<Correccion>[] = [
  { key: "at", header: "Cuándo", cell: (c) => formatInstant(c.at) },
  { key: "order", header: "Comanda", kind: "id", cell: (c) => `#${c.fila.order_id}` },
  {
    key: "what",
    header: "Qué",
    kind: "name",
    cell: (c) =>
      c.tipo === "void" ? (
        <>
          Anulación · <span>{`${c.fila.qty} × ${c.fila.item_name}`}</span>
        </>
      ) : c.fila.kind === "courtesy" ? (
        "Cortesía"
      ) : (
        "Descuento"
      ),
  },
  {
    key: "reason",
    header: "Motivo",
    cell: (c) =>
      c.tipo === "void"
        ? (c.fila.reason ? (VOID_REASON_LABEL[c.fila.reason] ?? c.fila.reason) : "—") +
          (c.fila.after_bill ? " · después de la cuenta" : "")
        : c.fila.reason
          ? ((c.fila.kind === "courtesy" ? COURTESY_REASON_LABEL : DISCOUNT_REASON_LABEL)[c.fila.reason] ?? c.fila.reason)
          : "—",
  },
  { key: "who", header: "Quién", cell: (c) => (c.tipo === "void" ? c.fila.voided_by : c.fila.employee_name) ?? "—" },
  { key: "auth", header: "Autorizó", cell: (c) => c.fila.authorized_by ?? "—" },
  { key: "amount", header: "Valor", kind: "number", cell: (c) => formatCOP(c.fila.amount) },
]

function correcciones(r: ShiftRecordOut): Correccion[] {
  const filas: Correccion[] = [
    ...r.voids.map((v, i) => ({ tipo: "void" as const, clave: `v-${v.order_id}-${i}`, at: v.voided_at, fila: v })),
    ...r.discounts.map((d, i) => ({ tipo: "discount" as const, clave: `d-${d.order_id}-${i}`, at: d.at, fila: d })),
  ]
  // Orden de tiempo, para leerlas como pasaron (ordenar filas no es calcular).
  return filas.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
}

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

/** «Turno del martes 16 sep»: el día operativo en palabras. */
function tituloDelTurno(businessDate: string): string {
  const [, dia, mes] = formatFechaCorta(businessDate).split(" ")
  const nombre = weekdayName(businessDate)
  return nombre && dia && mes ? `Turno del ${nombre} ${dia} ${mes}` : `Turno del ${formatBusinessDate(businessDate)}`
}

/** El tono de una diferencia de caja: el mismo criterio que `Diferencia`. */
function tonoDiferencia(dif: number | null | undefined): "success" | "destructive" | "warning" | "muted" {
  if (dif === null || dif === undefined) return "muted"
  if (dif === 0) return "success"
  return dif < 0 ? "destructive" : "warning"
}

const FRANJA_TONO: Record<ReturnType<typeof tonoDiferencia>, string> = {
  success: "border-t-success",
  destructive: "border-t-destructive",
  warning: "border-t-warning",
  muted: "border-t-border",
}

/** La pastilla de estado al lado del título: cómo terminó el turno. */
function EstadoTurno({ r, s }: { r: ShiftRecordOut; s: ShiftSummary }): React.JSX.Element {
  let texto: string
  let clase: string
  if (r.is_stale) {
    texto = "■ Abandonado: sigue abierto"
    clase = "bg-destructive/12 text-destructive"
  } else if (r.status === "open") {
    texto = "● Abierto"
    clase = "bg-accent text-accent-foreground"
  } else if (s.difference === null || s.difference === undefined) {
    texto = s.closed_without_count ? "Cerró sin conteo" : "Cerró sin diferencia registrada"
    clase = "bg-muted text-muted-foreground"
  } else if (s.difference === 0) {
    texto = "● Cerró cuadrado"
    clase = "bg-success/12 text-success"
  } else {
    // La cifra va como la manda el servidor; sólo se le quita el signo
    // para escribirla después de «faltante de» / «sobrante de».
    const cifra = formatCOP(s.difference).replace(/^[-−]\s*/, "")
    texto = s.difference < 0 ? `▼ Cerró con faltante de ${cifra}` : `▲ Cerró con sobrante de ${cifra}`
    clase = s.difference < 0 ? "bg-destructive/12 text-destructive" : "bg-warning/15 text-warning"
  }
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold whitespace-nowrap", clase)}>
      {texto}
    </span>
  )
}

interface Paso {
  clave: string
  cuando: string
  titulo: string
  quien: string
  esperado: number | null | undefined
  contado: number | null | undefined
  diferencia: number | null | undefined
  motivoSinDato: string
  pie?: React.ReactNode
}

/** «¿Cuadró en cada paso?»: apertura → relevos → cierre, cada uno con esperado, contado y diferencia. */
function PasosDeCaja({ r, s }: { r: ShiftRecordOut; s: ShiftSummary }): React.JSX.Element {
  const abierto = r.status === "open"
  const pasos: Paso[] = []
  if (r.opening_count) {
    const oc = r.opening_count
    pasos.push({
      clave: "apertura",
      cuando: `Apertura · ${formatClockTime(oc.counted_at)}`,
      titulo:
        oc.envelopes.length === 1
          ? `Sobre del ${formatFechaCorta(oc.envelopes[0]!.business_date)}`
          : `${oc.envelopes.length} sobres`,
      quien: `Contó ${oc.counted_by}`,
      esperado: oc.expected_total,
      contado: oc.counted_total,
      diferencia: oc.difference_total ?? (oc.envelopes.length === 1 ? oc.envelopes[0]!.difference : null),
      motivoSinDato: "la diferencia está sobre por sobre en el detalle",
    })
  } else {
    pasos.push({
      clave: "apertura",
      cuando: `Apertura · ${formatClockTime(r.opened_at)}`,
      titulo: r.opening_mode === "envelopes" ? "Sin conteo de sobres sellado" : "Base fija",
      quien: `Abrió ${r.opened_by.name}`,
      esperado: s.opening_cash_total,
      contado: null,
      diferencia: null,
      motivoSinDato: "la base fija no se cuenta al abrir",
    })
  }
  for (const h of s.handovers ?? []) {
    const relevo = h.kind !== "spot_check"
    pasos.push({
      clave: `h-${h.id}`,
      cuando: `${relevo ? "Relevo" : "Arqueo sorpresa"} · ${formatClockTime(h.at)}`,
      titulo:
        relevo && h.new_responsible
          ? `${h.from_responsible?.name ?? "—"} entrega a ${h.new_responsible.name ?? "—"}`
          : "Arqueo del cajón",
      quien: relevo ? "Contaron los dos" : `Contó ${h.from_responsible?.name ?? "—"}`,
      esperado: h.breakdown?.expected,
      contado: h.counted_cash,
      diferencia: h.breakdown?.difference,
      motivoSinDato: "no quedó el esperado congelado",
    })
  }
  pasos.push({
    clave: "cierre",
    cuando: abierto ? "Cierre · todavía no" : `Cierre · ${formatClockTime(s.closed_at ?? r.closed_at)}`,
    titulo: abierto ? (r.is_stale ? "Nadie lo cerró" : "Sigue abierto") : "Cierre de caja",
    quien: abierto ? "Esperado ahora" : r.closed_by ? `Contó ${r.closed_by}` : "Cerró",
    esperado: s.expected_cash,
    contado: abierto ? null : s.counted_cash,
    diferencia: abierto ? null : s.difference,
    motivoSinDato: abierto ? "el turno sigue abierto" : s.closed_without_count ? "se cerró sin conteo" : "sin conteo de cierre",
    pie: r.deposit ? (
      <span className="text-xs text-muted-foreground">
        Consignado {formatCOP(r.deposit.deposited_total)}
        {r.deposit.outstanding !== null ? ` · falta ${formatCOP(r.deposit.outstanding)}` : ""}
      </span>
    ) : undefined,
  })

  return (
    <PreguntaFicha titulo="¿Cuadró en cada paso?">
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0 lg:flex-row lg:items-stretch">
        {pasos.map((p, i) => (
          <li key={p.clave} className="flex min-w-0 flex-1 items-stretch gap-2.5">
            <div
              data-paso={p.clave}
              className={cn(
                // «Burbujas» (`BubFichaTurno`): burbuja de radio 20 con sólo la
                // franja de arriba, del tono de la diferencia.
                "flex min-w-0 flex-1 flex-col gap-1 rounded-[20px] border-0 border-t-[3px] bg-card p-4",
                FRANJA_TONO[tonoDiferencia(p.diferencia)],
              )}
            >
              <span className="text-xs text-muted-foreground">{p.cuando}</span>
              <b className="text-base">{p.titulo}</b>
              <span className="text-[13px] text-muted-foreground">{p.quien}</span>
              <span className="mt-1 flex flex-wrap gap-x-3.5 text-[13px]">
                <span>
                  Esperado <b className="tabular-nums">{p.esperado === null || p.esperado === undefined ? "—" : formatCOP(p.esperado)}</b>
                </span>
                <span>
                  Contado <b className="tabular-nums">{p.contado === null || p.contado === undefined ? "—" : formatCOP(p.contado)}</b>
                </span>
              </span>
              {/* La cifra grande sólo cuando hay cifra: un «sin dato» va en su tamaño. */}
              {/* La cifra grande sólo cuando hay cifra; sin ella, una frase apagada
                  (la trama de la celda de tabla, a tarjeta ancha, se veía rota). */}
              {p.diferencia === null || p.diferencia === undefined ? (
                <SinDato motivo={p.motivoSinDato} className="text-[13px]" />
              ) : (
                <span className="text-xl">
                  <Diferencia valor={p.diferencia} motivoSinDato={p.motivoSinDato} />
                </span>
              )}
              {p.pie}
            </div>
            {i < pasos.length - 1 ? (
              <ArrowRight className="hidden size-5 shrink-0 self-center text-muted-foreground lg:block" aria-hidden="true" />
            ) : null}
          </li>
        ))}
      </ol>
      <p className="text-[13px] text-muted-foreground">
        Cada conteo fue a ciegas: quien contó no vio el esperado. Una diferencia se corrige con motivo, no se borra.
      </p>
    </PreguntaFicha>
  )
}

/** «Efectivo en caja»: el esperado por hora contra el umbral de retiro, con los retiros marcados. */
function EfectivoEnCaja({ serie }: { serie: CashByHourSeriesOut }): React.JSX.Element {
  const puntos = serie.points
  const resumen: RenglonResumen[] = []
  // Franjas seguidas de horas que el servidor marcó sobre el umbral.
  const franjas: { desde: number; hasta: number }[] = []
  puntos.forEach((p, i) => {
    if (!p.outside) return
    const ultima = franjas[franjas.length - 1]
    if (ultima && ultima.hasta === i - 1) ultima.hasta = i
    else franjas.push({ desde: i, hasta: i })
  })
  if (franjas.length === 0) {
    resumen.push({
      titulo: "El efectivo nunca pasó el umbral",
      detalle: serie.reference !== null ? `Ninguna hora llegó a ${formatCOP(serie.reference)} en el cajón.` : "Sin umbral de retiro configurado.",
      tono: "success",
    })
  }
  for (const f of franjas) {
    const desde = puntos[f.desde]!.label
    const retiro = puntos.slice(f.desde, f.hasta + 2).find((p) => p.pickups.length > 0)
    const ultimo = f.hasta === puntos.length - 1
    resumen.push({
      titulo: f.desde === f.hasta ? `A las ${desde} pasó el umbral` : `Desde las ${desde} pasó el umbral`,
      detalle: retiro
        ? `Se retiró a las ${retiro.label}: ${retiro.pickups.map((a) => `↓ ${formatCOP(a)}`).join(", ")}.`
        : ultimo
          ? `No se retiró: ${serie.points.length > 0 && puntos[puntos.length - 1]!.now ? "sigue" : "cerró"} con ${formatCOP(puntos[puntos.length - 1]!.value)} en el cajón.`
          : "No hubo retiro en esas horas.",
      tono: retiro ? "success" : "warning",
    })
  }
  if (serie.truncated) {
    resumen.push({
      titulo: "La serie se cortó",
      detalle: serie.truncated_reason ?? "El turno lleva demasiadas horas abierto para dibujarlo entero.",
      tono: "muted",
    })
  }
  return (
    <PreguntaFicha titulo="Efectivo en caja">
      {!serie.available ? (
        <p className="sin-dato sin-dato--calmo text-sm">{serie.reason ?? "No se pudo leer el efectivo por hora."}</p>
      ) : (
        <BarrasConReferencia
          pregunta="¿Cuándo hubo más efectivo del que debía?"
          variante="columnas"
          malo="encima"
          alto={190}
          referenciaComun={serie.reference}
          formato={formatCOP}
          leyenda={{
            barra: "Efectivo en caja a esa hora",
            fuera: "Por encima del umbral",
            raya: serie.reference !== null ? `Umbral de retiro ${formatCOP(serie.reference)}` : "Sin umbral",
          }}
          puntos={puntos.map((p) => ({
            key: p.key,
            etiqueta: p.label,
            valor: p.value,
            referencia: p.reference,
            fuera: p.outside,
            ahora: p.now,
            // Sin cifra arriba: la columna lleva ▲ si pasó el umbral y la
            // cifra exacta va en el globo y en la lectura accesible.
            cifra: "",
            extra: p.pickups.length > 0 ? p.pickups.map((a) => `↓ ${formatCOP(a)}`).join(" ") : undefined,
          }))}
          extraVacio=""
          claseExtra="whitespace-nowrap text-[11px] font-bold text-primary"
          rotuloResumen="Lo que dice el día"
          resumen={resumen}
        />
      )}
    </PreguntaFicha>
  )
}

/** «Quién trabajó»: la asistencia del turno como barras de horario, con el relevo. */
function QuienTrabajo({ r, s }: { r: ShiftRecordOut; s: ShiftSummary }): React.JSX.Element {
  // Una fila por persona (agrupar entradas, no sumar nada).
  const porPersona = new Map<number, RecordAttendanceOut[]>()
  for (const a of r.attendance) porPersona.set(a.employee_id, [...(porPersona.get(a.employee_id) ?? []), a])
  const filas: FilaHorario[] = [...porPersona.entries()].map(([id, entradas]) => ({
    key: String(id),
    etiqueta: entradas[0]!.employee_name,
    href: fichaPersonaHref(id),
    detalle:
      entradas.length === 1
        ? entradas[0]!.out_at === null
          ? "sigue adentro"
          : entradas[0]!.worked_minutes === null || entradas[0]!.worked_minutes === undefined
            ? undefined
            : formatDuracion(entradas[0]!.worked_minutes)
        : `${entradas.length} entradas`,
    tramos: entradas.map((a) => ({ entrada: a.in_at, salida: a.out_at })),
  }))
  const relevos = (s.handovers ?? [])
    .filter((h) => h.kind !== "spot_check" && h.at)
    .map((h) => ({
      hora: h.at!,
      etiqueta: `Relevo de caja ${formatClockTime(h.at)} · ${h.from_responsible?.name ?? "—"} entrega a ${h.new_responsible?.name ?? "—"}`,
    }))
  return (
    <PreguntaFicha titulo="Quién trabajó">
      {filas.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Nadie quedó registrado en el turno.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5 rounded-lg border bg-card p-4">
          <HorarioGantt
            filas={filas}
            relevos={relevos}
            ahora={r.status === "open" ? new Date().toISOString() : undefined}
          />
          {relevos.map((rv) => (
            <span key={rv.hora} className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span aria-hidden="true" className="h-3.5 w-0 border-l-2 border-dashed border-foreground" />
              {rv.etiqueta}
            </span>
          ))}
        </div>
      )}
    </PreguntaFicha>
  )
}

/**
 * **Ficha del turno** (handoff del panel, pantalla 9 · `AdminFichaTurno`):
 * la banda de cifra con las ventas del turno, «¿Cuadró en cada paso?»
 * (apertura → relevos → cierre, con esperado, contado y diferencia: el
 * dueño sí ve el esperado), «Efectivo en caja» (barra + raya contra el
 * umbral de retiro, con los retiros marcados), «Quién trabajó» (barras de
 * horario con el relevo) y, plegado, «Ver el detalle del turno» con las
 * tablas: sobres, retiros, gastos e ingresos, base, relevos, correcciones,
 * novedades, conteos por área y asistencia. Los rescates de administrador
 * se abren desde acá con el mismo diálogo de Dinero.
 *
 * Nada se calcula acá: la plata la trae `GET /shifts/{id}` y el resto
 * `GET /admin/records/shift/{id}` (con `cash_by_hour` ya contra su raya).
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
  const relevos = (s.handovers ?? []).filter((h) => h.kind !== "spot_check").length
  const personas = new Set(r.attendance.map((a) => a.employee_id)).size
  const lista = correcciones(r)
  const conBase = r.reserve_loan_outstanding !== null || r.reserve_movements.length > 0
  // Cuántas listas y filas hay detrás del botón: contar filas, no plata.
  const listas = conBase ? 9 : 8
  const registros =
    (r.opening_count?.envelopes.length ?? 0) +
    (s.pickups?.length ?? 0) +
    (s.movements?.length ?? 0) +
    r.reserve_movements.length +
    (s.handovers?.length ?? 0) +
    lista.length +
    r.novelties.length +
    r.area_counts.length +
    r.attendance.length

  return (
    <div className="space-y-[18px]">
      <Link
        to="/admin/dinero"
        title="Volver a Dinero"
        className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
      >
        <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
        Volver a Dinero
      </Link>
      <PageHeader
        name={tituloDelTurno(r.business_date)}
        question="Todo lo que se relaciona con este turno: sus ventas, si la caja cuadró en cada paso, cuándo hubo más efectivo del que debía, quién trabajó y, en el detalle, cada sobre, retiro, gasto, relevo, corrección, conteo y entrada."
        context={[
          { label: <EstadoTurno r={r} s={s} /> },
          { label: r.store_name },
          {
            label: "Abrió",
            value: (
              <>
                {formatClockTime(r.opened_at)} ·{" "}
                <PersonaLink id={r.opened_by.id} name={r.opened_by.name} active={r.opened_by.active} />
              </>
            ),
          },
          abierto
            ? { label: "Responsable", value: <PersonaLink id={r.responsible.id} name={r.responsible.name} active={r.responsible.active} /> }
            : { label: "Cerró", value: `${formatClockTime(r.closed_at)}${r.closed_by ? ` · ${r.closed_by}` : ""}` },
          {
            label: `${relevos} ${relevos === 1 ? "relevo" : "relevos"} · ${personas} ${personas === 1 ? "persona" : "personas"}`,
          },
          { label: `Turno #${r.shift_id}`, title: `Día operativo ${formatBusinessDate(r.business_date)}` },
        ]}
        actions={
          <Button type="button" size="sm" variant="outline" onClick={() => setRescates(true)} title="Rescates y revisión">
            Rescates y revisión
          </Button>
        }
      />

      {r.is_stale ? (
        <p role="status" className="rounded-lg border border-destructive/30 border-l-[3px] border-l-destructive bg-destructive/5 px-3 py-2 text-sm">
          Este turno pasó la hora de corte del día siguiente y nadie lo cerró. No bloquea la venta, pero su plata no
          se cuadró: cerralo con el cierre administrativo desde «Rescates y revisión».
          {!r.responsible.active ? ` Su responsable, ${r.responsible.name}, ya no está activo.` : ""}
        </p>
      ) : null}

      {r.sales ? (
        <HeadlineFigure
          label="Ventas netas del turno"
          value={formatCOP(r.sales.net)}
          note={`${r.sales.orders ?? 0} ${r.sales.orders === 1 ? "comanda pagada" : "comandas pagadas"}`}
          ledger={{
            rows: [
              { label: "Cobrado en caja y medios", value: formatCOP(r.sales.gross) },
              { label: "Impuesto discriminado", value: formatCOP(r.sales.tax), kind: "subtract" },
            ],
            total: { label: "Ventas netas", value: formatCOP(r.sales.net) },
          }}
          belowTheLine={
            r.sales.tips === null || r.sales.tips === undefined
              ? undefined
              : { label: "Propinas · pasan a los meseros, no son venta", value: formatCOP(r.sales.tips) }
          }
        />
      ) : (
        <StatTile label="Ventas netas del turno" value={null} nullNote="El turno no cobró ninguna comanda." />
      )}

      <PasosDeCaja r={r} s={s} />

      {r.cash_by_hour ? <EfectivoEnCaja serie={r.cash_by_hour} /> : null}

      <QuienTrabajo r={r} s={s} />

      <DetallePlegable texto={`Ver el detalle del turno · ${listas} listas, ${registros} registros`}>
        {r.opening_count ? (
          <SeccionFicha
            titulo="Apertura por sobres"
            dice={`contó ${r.opening_count.counted_by} a ciegas, sobre por sobre`}
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
          titulo="Gastos e ingresos de caja"
          dice="ingresos y egresos con su causa"
          sustantivo="movimientos"
          vacio="No hubo ingresos ni egresos de caja."
          columns={MOVEMENT_COLUMNS}
          rows={s.movements ?? []}
          rowKey={(m) => String(m.id)}
        />
        {conBase ? (
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
          titulo="Relevos y arqueos"
          dice="quién entregó el cajón a quién, y lo contado"
          sustantivo="relevos"
          vacio="Nadie relevó la caja en este turno."
          columns={HANDOVER_COLUMNS}
          rows={s.handovers ?? []}
          rowKey={(h) => String(h.id)}
        />
        <SeccionFicha
          titulo="Anulaciones, descuentos y cortesías"
          dice="lo que se anuló, se cobró de menos o se regaló, con quién lo autorizó"
          sustantivo="correcciones"
          vacio="No hubo anulaciones, descuentos ni cortesías en este turno."
          columns={CORRECTION_COLUMNS}
          rows={lista}
          rowKey={(c) => c.clave}
          ancha
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
          titulo="Novedades"
          dice="lo que el salón registró durante el turno"
          sustantivo="novedades"
          vacio="Nadie registró novedades en este turno."
          columns={NOVELTY_COLUMNS}
          rows={r.novelties}
          rowKey={(n) => String(n.id)}
        />
        <SeccionFicha
          titulo="Asistencia"
          dice="quién estuvo en este turno (la asistencia del día sobre la ventana del turno)"
          sustantivo="entradas"
          vacio="Nadie quedó registrado en el turno."
          columns={attendanceColumns("persona")}
          rows={r.attendance}
          rowKey={(a) => `${a.employee_id}-${a.in_at}`}
          ancha
        />
        <p className="text-xs text-muted-foreground lg:col-span-2">{ATTENDANCE_NOTE}</p>
      </DetallePlegable>

      {rescates ? (
        <ShiftRescuesDialog
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
