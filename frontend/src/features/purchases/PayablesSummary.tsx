/**
 * La cabecera de Compras › Cuentas por pagar (informe de visualización #8):
 * «Debés $X · $Y vencido · $Z vence en 7 días», la antigüedad por tramo y a
 * quién se le debe. Todo sale de `GET /admin/payables/summary`: los totales,
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

import { AGING_EJE, AGING_LABEL, cuentas, payablesHeadline } from "./lib"

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
      <div className="space-y-1">
        <h3 data-testid="payables-headline" className="text-lg leading-snug font-semibold">
          {payablesHeadline(s)}
        </h3>
        <p className="text-xs text-muted-foreground">
          Saldos vivos al {formatFechaCorta(s.as_of)}, de todas las cuentas sin cancelar (también las pendientes de
          revisión): no depende del rango de la tabla de abajo.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Debés en total" value={formatCOP(s.total_open)} hint={`${cuentas(s.open_count)} con saldo.`} />
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
          hint="Lo que vence entre hoy y dentro de una semana."
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
