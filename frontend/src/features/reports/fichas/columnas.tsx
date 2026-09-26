import { Link } from "react-router-dom"

import type { RecordAttendanceOut, RecordDiscountOut, RecordVoidOut } from "@/api/panel"
import type { DenseColumn } from "@/components/admin"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { formatCOP } from "@/lib/money"

import { COURTESY_REASON_LABEL, DISCOUNT_REASON_LABEL, VOID_REASON_LABEL } from "@/features/orders/lib"

import { PersonaLink } from "./comun"
import { fichaTurnoHref } from "./rutas"

/** Columnas compartidas por las fichas (turno y persona). */
export const VOID_COLUMNS: readonly DenseColumn<RecordVoidOut>[] = [
  { key: "item", header: "Ítem", kind: "name", cell: (v) => `${v.qty} × ${v.item_name}` },
  { key: "amount", header: "Valor", kind: "number", cell: (v) => formatCOP(v.amount) },
  {
    key: "reason",
    header: "Motivo",
    cell: (v) => (v.reason ? (VOID_REASON_LABEL[v.reason] ?? v.reason) : "—") + (v.after_bill ? " · después de la cuenta" : ""),
  },
  { key: "who", header: "Quién", cell: (v) => v.voided_by ?? "—" },
  { key: "auth", header: "Autorizó", cell: (v) => v.authorized_by ?? "—" },
  { key: "order", header: "Comanda", kind: "id", secondary: true, cell: (v) => `#${v.order_id}` },
  { key: "at", header: "Cuándo", kind: "secondary", secondary: true, cell: (v) => formatInstant(v.voided_at) },
]

export const DISCOUNT_COLUMNS: readonly DenseColumn<RecordDiscountOut>[] = [
  { key: "kind", header: "Tipo", cell: (d) => (d.kind === "courtesy" ? "Cortesía" : "Descuento") },
  { key: "amount", header: "Valor", kind: "number", cell: (d) => formatCOP(d.amount) },
  {
    key: "reason",
    header: "Motivo",
    cell: (d) =>
      d.reason
        ? ((d.kind === "courtesy" ? COURTESY_REASON_LABEL : DISCOUNT_REASON_LABEL)[d.reason] ?? d.reason)
        : "—",
  },
  { key: "who", header: "Quién", cell: (d) => d.employee_name ?? "—" },
  { key: "auth", header: "Autorizó", cell: (d) => d.authorized_by ?? "—" },
  { key: "order", header: "Comanda", kind: "id", secondary: true, cell: (d) => `#${d.order_id}` },
  { key: "at", header: "Cuándo", kind: "secondary", secondary: true, cell: (d) => formatInstant(d.at) },
]

/** Asistencia: con quién (enlace a su ficha) o con qué turno (enlace a la del turno). */
export function attendanceColumns(por: "persona" | "turno"): readonly DenseColumn<RecordAttendanceOut>[] {
  const primera: DenseColumn<RecordAttendanceOut> =
    por === "persona"
      ? {
          key: "who",
          header: "Persona",
          kind: "name",
          cell: (a) => <PersonaLink id={a.employee_id} name={a.employee_name} />,
        }
      : {
          key: "shift",
          header: "Turno",
          kind: "name",
          cell: (a) => (
            <Link to={fichaTurnoHref(a.shift_id)} className="text-primary hover:underline">
              #{a.shift_id} · {formatBusinessDate(a.business_date)}
            </Link>
          ),
        }
  return [
    primera,
    { key: "in", header: "Entró", cell: (a) => formatInstant(a.in_at) },
    { key: "out", header: "Salió", cell: (a) => (a.out_at ? formatInstant(a.out_at) : "Sigue adentro") },
    {
      key: "kind",
      header: "Cómo",
      cell: (a) => (a.clocked_in ? "Marcó entrada" : "Sólo se identificó"),
    },
  ]
}

/** La leyenda de asistencia, dicha una vez donde se muestra. */
export const ATTENDANCE_NOTE =
  "«Sólo se identificó»: puso su PIN en la tablet (para cobrar, autorizar o anular) pero no marcó entrada. No cuenta como que trabajó."
