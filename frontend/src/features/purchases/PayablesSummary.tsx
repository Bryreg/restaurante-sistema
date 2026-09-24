/**
 * La cabecera de Compras › Cuentas por pagar (informe de visualización #8):
 * «Debés $X» como cifra protagonista, con lo vencido y lo que vence en 7 días
 * al lado, la antigüedad por tramo y a quién se le debe. Todo sale de `GET /admin/payables/summary`: los totales,
 * los tramos y el corte por proveedor los suma el servidor, acá sólo se
 * dibujan. Es la foto de HOY, no depende del rango de la tabla de abajo.
 */
import { useQuery } from "@tanstack/react-query"

import { getPayablesSummary } from "@/api/purchases"
import { BarList, ChartFrame, ColumnChart } from "@/components/charts"
import { StatTile } from "@/components/StatTile"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { AGING_EJE, AGING_LABEL, cuentas } from "./lib"

export function PayablesSummary({ storeId }: { storeId: number }): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ["purchases", "payables", "summary", storeId],
    queryFn: () => getPayablesSummary(storeId),
  })

  if (query.isLoading) return <p className="text-sm text-muted-foreground">Sumando lo que se debe…</p>
  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        No se pudo cargar el resumen de lo que se debe: {errorMessage(query.error)}
      </p>
    )
  }
  const s = query.data
  if (!s) return null

  const vencidoMayor = s.aging.filter((a) => a.bucket !== "current" && a.amount > 0)
  const peorTramo = vencidoMayor.length > 0 ? vencidoMayor[vencidoMayor.length - 1] : null
  const agingTitular =
    s.overdue_count === 0 || peorTramo === null
      ? "Todo lo que se debe está al día"
      : `${cuentas(s.overdue_count)} ${s.overdue_count === 1 ? "vencida" : "vencidas"}; la más vieja cae en «${AGING_LABEL[peorTramo.bucket].toLowerCase()}»`

  const conDeuda = s.by_supplier.filter((p) => p.open > 0)
  const primero = conDeuda[0]
  const proveedorTitular = primero
    ? `A ${primero.name} es a quien más se le debe: ${formatCOP(primero.open)}`
    : "No hay saldo con ningún proveedor"

  return (
    <section aria-label="Resumen de lo que se debe" className="space-y-4">
      {/* **Una cifra protagonista** (mapa de pantallas, regla 1): lo que se
          debe, grande y en ámbar —es plata pendiente—; lo vencido y lo que
          vence en la semana, al lado y más chico. Las tres cifras son las del
          servidor, tal cual. La frase que las repetía de corrido arriba de
          las tarjetas (`payablesHeadline`) sobraba: decía tres veces lo mismo. */}
      <div className="grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,max-content)_minmax(0,1fr)_minmax(0,1fr)]">
        <div data-testid="payables-headline" className="min-w-0 py-1 sm:col-span-2 lg:col-span-1 lg:pr-4">
          <p className="text-[0.7rem] tracking-wider text-muted-foreground uppercase">Debés en total</p>
          <p
            className={cn(
              "mt-0.5 text-4xl leading-none font-bold tracking-tight whitespace-nowrap tabular-nums",
              s.open_count > 0 ? "text-warning" : "text-foreground",
            )}
          >
            {formatCOP(s.total_open)}
          </p>
          <p
            className="mt-1.5 text-xs text-muted-foreground"
            title="De todas las cuentas sin cancelar, también las pendientes de revisión. Es la foto de hoy: no depende del rango de la tabla de abajo."
          >
            {cuentas(s.open_count)} con saldo · al {formatFechaCorta(s.as_of)}
          </p>
        </div>
        <StatTile
          label="Vencido"
          value={formatCOP(s.total_overdue)}
          tone={s.overdue_count > 0 ? "critical" : "default"}
          hint={s.overdue_count > 0 ? `${cuentas(s.overdue_count)} ya pasaron su plazo.` : "Ninguna pasó su plazo."}
          link={
            s.overdue_count > 0
              ? { to: "/admin/compras?tab=cuentas-por-pagar&vencidas=1", screen: "Compras", tab: "Cuentas por pagar", filter: "sólo vencidas" }
              : undefined
          }
        />
        <StatTile
          label="Vence en 7 días"
          value={formatCOP(s.due_next_7_days)}
          tone={s.due_next_7_days > 0 ? "warning" : "default"}
          hint="Entre hoy y dentro de una semana."
        />
      </div>

      {s.open_count > 0 ? (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <div className="rounded-lg border bg-card p-4">
            <ChartFrame
              titular={agingTitular}
              detalle="Saldo por antigüedad, en pesos. «Al día» incluye lo que vence hoy."
              tabla={{
                columnas: [
                  { key: "tramo", header: "Antigüedad" },
                  { key: "count", header: "Cuentas", align: "right" },
                  { key: "amount", header: "Saldo", align: "right" },
                ],
                filas: s.aging.map((a) => ({
                  tramo: AGING_LABEL[a.bucket],
                  count: String(a.count),
                  amount: formatCOP(a.amount),
                })),
              }}
            >
              <ColumnChart
                alto={140}
                datos={s.aging.map((a) => ({ key: a.bucket, etiqueta: AGING_EJE[a.bucket], valor: a.amount }))}
                formato={formatCOP}
                resaltar={peorTramo?.bucket}
              />
            </ChartFrame>
          </div>
          <div className="rounded-lg border bg-card p-4">
            <ChartFrame
              titular={proveedorTitular}
              detalle="Saldo abierto por proveedor, de mayor a menor; al lado, cuánto de eso está vencido."
              tabla={{
                columnas: [
                  { key: "name", header: "Proveedor" },
                  { key: "open", header: "Saldo", align: "right" },
                  { key: "overdue", header: "Vencido", align: "right" },
                ],
                filas: conDeuda.map((p) => ({
                  name: p.name,
                  open: formatCOP(p.open),
                  overdue: formatCOP(p.overdue),
                })),
              }}
            >
              <BarList
                max={5}
                datos={conDeuda.map((p) => ({
                  key: String(p.supplier_id),
                  etiqueta: p.name,
                  valor: p.open,
                  detalle: p.overdue > 0 ? `${formatCOP(p.overdue)} vencido` : undefined,
                }))}
                formato={formatCOP}
              />
            </ChartFrame>
          </div>
        </div>
      ) : null}
    </section>
  )
}

export default PayablesSummary
