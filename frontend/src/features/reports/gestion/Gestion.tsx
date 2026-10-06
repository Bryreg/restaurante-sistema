import { useId } from "react"

import type {
  ControlPersonRowOut,
  LaborByHourOut,
  ManagementOut,
  PrimeCostOut,
  TurnoverOut,
} from "@/api/reports"
import { DenseTable, type DenseColumn } from "@/components/admin"
import { BarrasConReferencia } from "@/components/charts"
import { StatTile, cifraOSinDato } from "@/components/StatTile"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { formatHorasTexto, formatVueltas } from "./lib"

/**
 * Gestión del período en Informes (h2, h3, h4, h8): todo de
 * `GET /admin/reports/management`. Acá no se suma, ni se divide, ni se
 * reparte nada: cada cifra llega hecha y, si falta, con su motivo.
 */

function Bloque({
  titulo,
  subtitulo,
  children,
}: {
  titulo: string
  subtitulo?: string
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={id} className="text-lg leading-snug font-bold">
          {titulo}
        </h2>
        {subtitulo ? <span className="text-[13px] text-muted-foreground">{subtitulo}</span> : null}
      </div>
      {children}
    </section>
  )
}

const BASE_COSTO: Record<string, string> = {
  real: "costo real: fichas + varianza de inventario",
  theoretical: "costo teórico de las fichas",
}

/** h3 · Costo primo = costo de lo vendido + mano de obra. */
export function CostoPrimo({ data, compacto = false }: { data: PrimeCostOut; compacto?: boolean }): React.JSX.Element {
  const base = data.cost_basis ? BASE_COSTO[data.cost_basis] : null
  const tiles = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatTile
        label="Costo primo"
        {...(data.prime_cost === null
          ? { value: null, nullNote: data.reason ?? "Falta un dato para calcularlo." }
          : { value: formatCOP(data.prime_cost) })}
        hint={
          data.prime_cost_pct_bp !== null
            ? `${formatPct(data.prime_cost_pct_bp)} de la venta neta (${formatCOP(data.net_sales)})`
            : data.prime_cost !== null
              ? (data.reason ?? undefined)
              : undefined
        }
      />
      <StatTile
        label="Costo de lo vendido"
        {...cifraOSinDato(data.cost_of_goods, data.cost_reason ?? "Sin costo de lo vendido.")}
        hint={
          data.cost_of_goods === null
            ? undefined
            : [base, data.cost_pct_bp !== null ? `${formatPct(data.cost_pct_bp)} de la venta` : null]
                .filter(Boolean)
                .join(" · ")
        }
      />
      <StatTile
        label="Mano de obra"
        {...cifraOSinDato(data.labor, data.labor_reason ?? "Sin nómina del período.")}
        hint={data.labor_pct_bp !== null ? `${formatPct(data.labor_pct_bp)} de la venta · nómina con prestaciones` : undefined}
      />
    </div>
  )
  if (compacto) return tiles
  return (
    <Bloque titulo="Costo primo" subtitulo="Lo que cuesta lo vendido más la gente que lo hizo, contra la venta">
      {tiles}
      {data.cost_basis === "theoretical" && data.cost_real_reason ? (
        <p className="text-xs text-muted-foreground">
          Se usa el costo teórico porque el real no está: {data.cost_real_reason}
        </p>
      ) : null}
    </Bloque>
  )
}

/** h2 · Rotación de mesas y RevPASH. */
export function MesasYSillas({ data }: { data: TurnoverOut }): React.JSX.Element {
  return (
    <Bloque titulo="Mesas y sillas" subtitulo="¿Cuántas veces se usó cada mesa y cuánto deja cada silla por hora?">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile
          label="Rotación de mesas"
          {...(data.orders_per_table_service_bp === null
            ? { value: null, nullNote: data.turnover_reason ?? "Sin servicios en el período." }
            : { value: `${formatVueltas(data.orders_per_table_service_bp)} vueltas` })}
          hint={
            data.orders_per_table_service_bp === null
              ? undefined
              : `${data.dine_in_orders} ${data.dine_in_orders === 1 ? "comanda" : "comandas"} de mesa en ${data.tables ?? "—"} mesas y ${data.services} ${data.services === 1 ? "servicio" : "servicios"}`
          }
        />
        <StatTile
          label="Comensales por silla"
          {...(data.covers_per_seat_service_bp === null
            ? {
                value: null,
                nullNote: data.turnover_reason ?? "Sin comensales registrados en las comandas de mesa.",
              }
            : { value: formatVueltas(data.covers_per_seat_service_bp) })}
          hint={
            data.covers_per_seat_service_bp === null
              ? undefined
              : `${data.dine_in_covers ?? "—"} comensales en ${data.seats ?? "—"} sillas, por servicio`
          }
        />
        <StatTile
          label="RevPASH"
          {...cifraOSinDato(data.revpash, data.revpash_reason ?? "Sin sillas u horario.")}
          hint={
            data.revpash === null
              ? undefined
              : `venta neta por silla y hora abierta · ${formatHorasTexto(data.open_hours)} abiertas, ${data.seats ?? "—"} sillas`
          }
        />
      </div>
    </Bloque>
  )
}

/** h4 · Mano de obra contra la venta, por hora. */
export function ManoDeObraPorHora({ data }: { data: LaborByHourOut }): React.JSX.Element {
  return (
    <Bloque titulo="Mano de obra por hora" subtitulo="¿A qué horas la gente cuesta más de lo que se vende?">
      {!data.available ? (
        <p className="sin-dato sin-dato--calmo text-sm">{data.reason ?? "Sin nómina del período."}</p>
      ) : data.hours.length === 0 ? (
        <p className="sin-dato sin-dato--calmo text-sm">No hubo ventas ni horas trabajadas en el período.</p>
      ) : (
        <BarrasConReferencia
          pregunta="Venta neta y costo de la gente, hora por hora"
          variante="columnas"
          malo="debajo"
          alto={200}
          formato={formatCOP}
          leyenda={{
            barra: "Venta neta de la hora",
            raya: "Lo que costó la gente en esa hora",
            fuera: "La gente costó más de lo que se vendió",
          }}
          puntos={data.hours.map((h) => ({
            key: String(h.hour),
            etiqueta: h.label.slice(0, 2),
            valor: h.net,
            referencia: h.labor,
            fuera: h.outside ?? undefined,
            detalle: h.labor_pct_bp !== null ? formatPct(h.labor_pct_bp, 0) : undefined,
            extra: formatHorasTexto(h.worked_hours).replace(" h", ""),
          }))}
          unidadExtra="horas"
          rotuloResumen="El período en una línea"
          resumen={[
            {
              titulo: `${formatCOP(data.labor_total)} en ${formatHorasTexto(data.worked_hours_total)}`,
              detalle: "La nómina del período (con prestaciones) repartida según las horas trabajadas en cada hora del reloj.",
              tono: "data",
            },
          ]}
        />
      )}
    </Bloque>
  )
}

/** h8 · Anulaciones, descuentos y cortesías por persona. */
export function ControlesPorPersona({ data }: { data: ManagementOut["controls"] }): React.JSX.Element {
  const columns: readonly DenseColumn<ControlPersonRowOut>[] = [
    { key: "persona", header: "Persona", kind: "name", cell: (r) => r.employee_name },
    { key: "voids", header: "Anulaciones", kind: "number", cell: (r) => `${r.voids_count} · ${formatCOP(r.voids_amount)}` },
    {
      key: "discounts",
      header: "Descuentos",
      kind: "number",
      cell: (r) => `${r.discounts_count} · ${formatCOP(r.discounts_amount)}`,
    },
    {
      key: "courtesies",
      header: "Cortesías",
      kind: "number",
      cell: (r) => `${r.courtesies_count} · ${formatCOP(r.courtesies_amount)}`,
    },
    { key: "total", header: "Total", kind: "number", cell: (r) => formatCOP(r.total_amount) },
    {
      key: "authorizers",
      header: "Autorizó",
      cell: (r) => r.authorizers.map((a) => `${a.name} (${a.count})`).join(", "),
    },
  ]
  return (
    <Bloque
      titulo="Anulaciones, descuentos y cortesías"
      subtitulo={
        data.total_count === 0
          ? "Nadie anuló, descontó ni regaló nada en el período"
          : `${data.total_count} en el período por ${formatCOP(data.total_amount)}${
              data.total_pct_of_sales_bp !== null ? ` · ${formatPct(data.total_pct_of_sales_bp)} de la venta` : ""
            }`
      }
    >
      {data.rows.length === 0 ? (
        <p className="sin-dato sin-dato--calmo text-sm">No hubo anulaciones, descuentos ni cortesías en el período.</p>
      ) : (
        <DenseTable
          caption="Anulaciones, descuentos y cortesías por persona, con quién las autorizó"
          columns={columns}
          rows={data.rows}
          rowKey={(r) => `${r.employee_id ?? "x"}-${r.employee_name}`}
          note="La anulación vale el ítem a su precio; el descuento, lo descontado; la cortesía, el plato a precio de carta. Las mismas cifras de la ficha de cada persona."
        />
      )}
    </Bloque>
  )
}

/** Las cuatro secciones de gestión, en el orden en que se leen. */
export function GestionDelPeriodo({ data }: { data: ManagementOut }): React.JSX.Element {
  return (
    <div className="space-y-[22px]">
      <CostoPrimo data={data.prime_cost} />
      <ManoDeObraPorHora data={data.labor_by_hour} />
      <MesasYSillas data={data.turnover} />
      <ControlesPorPersona data={data.controls} />
    </div>
  )
}
