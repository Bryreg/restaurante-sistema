/**
 * Admin → Analítica → Varianza por plato (T4, `GET /admin/variance/by-dish`):
 * §5.4 la define explícitamente como "sólo estimación prorrateada" — esta
 * pantalla lo dice arriba de la tabla, con `method` tal cual llega, nunca
 * asumido como "prorated" por default si el backend mandara otra cosa.
 *
 * La ventana real de esta ruta es la del último conteo aplicado (`count_id`,
 * verificado contra `app/analytics/schemas.py::VarianceByDishOut`), no un
 * rango `from`/`to` de fecha de negocio — por eso esta pantalla no ofrece
 * `DateRangeFilter` (sería un filtro que no hace nada, el error contrario al
 * de un filtro que siempre `422`, ver `api/inventory.ts` sobre
 * `MovementCause`).
 *
 * Lectura (analista #11, científico #8): titular con el neto y el faltante
 * más grande, barras divergentes con los faltantes primero (el orden lo
 * manda el servidor), y el aviso de muestra chica con su motivo cuando la
 * ventana es corta o tiene pocas comandas. La dirección se dice con lado,
 * flecha y palabra; la cifra conserva el signo del servidor, en su propia
 * columna.
 */
import { useQuery } from "@tanstack/react-query"

import { getVarianceByDish, type VarianceByDishRowOut } from "@/api/analytics"
import { DenseTable, DenseTableBar, type DenseColumn } from "@/components/admin"
import { ChartFrame, DivergingBars, type DivergingDatum } from "@/components/charts"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { textoVentana } from "@/features/inventory/lib"

import { varianceByDishTitular } from "./titulares"

/**
 * La dirección con palabra: nunca sólo color ni sólo signo. Sin flecha a
 * propósito: en esta pantalla la flecha la pone `DivergingBars`, que la
 * orienta por el lado de la barra (▲ = real sobre teórico = faltante), y
 * dos convenciones de flecha en la misma pantalla se contradirían.
 */
function Direccion({ row }: { row: VarianceByDishRowOut }): React.JSX.Element {
  if (row.variance_value === null || row.variance_value === undefined) {
    return <span className="text-muted-foreground italic">Sin datos: insumos sin costo</span>
  }
  const falta = row.direction ? row.direction === "shortage" : row.variance_value > 0
  if (row.variance_value === 0) return <span className="text-success">cuadra</span>
  return (
    <span className={falta ? "font-medium text-destructive" : "font-medium text-warning"}>
      {falta ? "Faltante" : "Sobrante"}
    </span>
  )
}

const VARIANCE_COLUMNS: readonly DenseColumn<VarianceByDishRowOut>[] = [
  { key: "product", header: "Plato", kind: "name", cell: (r) => r.product_name ?? `#${r.product_id}` },
  { key: "direction", header: "Qué pasó", cell: (r) => <Direccion row={r} /> },
  {
    // La cifra con el signo del servidor (real − teórico: positivo = se usó
    // de más). Va sola, sin «sobrante» pegado: «−$ 167.500 sobrante» era una
    // doble negación (analista #11).
    key: "value",
    header: "Real − teórico",
    kind: "number",
    cell: (r) =>
      r.variance_value === null || r.variance_value === undefined ? (
        <span className="text-muted-foreground italic">Sin datos</span>
      ) : (
        formatCOP(r.variance_value)
      ),
  },
  {
    key: "share",
    header: "Peso del prorrateo",
    kind: "number",
    cell: (r) => formatPct(r.theoretical_consumption_share_bp ?? null),
  },
  { key: "ingredients", header: "Insumos involucrados", kind: "number", cell: (r) => r.ingredients_involved ?? "—" },
]

export function VarianceByDishTab({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: ["analytics", "variance-by-dish", storeId],
    queryFn: () => getVarianceByDish({ storeId }),
  })

  const data = query.data
  const rows = data?.rows ?? []
  const ventana = data
    ? textoVentana(data.window_hours, data.window_days, data.window_from, data.window_to)
    : undefined

  const datos: DivergingDatum[] = rows.map((r) => ({
    key: String(r.product_id),
    etiqueta: r.product_name ?? `#${r.product_id}`,
    valor: r.variance_value ?? null,
  }))

  return (
    <div className="space-y-4">
      {data ? (
        <p className="text-xs text-muted-foreground">
          Método: <strong>{data.method}</strong> — es una ESTIMACIÓN prorrateada sobre la ventana del último
          conteo aplicado, no una medición directa por plato (SPEC-NEGOCIO §5.4).
          {ventana ? ` Ventana: ${ventana}.` : ""}
        </p>
      ) : null}

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la varianza por plato…</p>
      ) : query.isError ? (
        <EmptyState reason="error" title="No se pudo calcular la varianza por plato" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : !data?.available ? (
        <EmptyState reason="dependency" title="Varianza por plato no disponible" description={data?.reason ?? "Hacen falta conteos completos aplicados y consecutivos."} />
      ) : rows.length === 0 ? (
        <EmptyState
          reason="dependency"
          title="No hay platos con varianza para mostrar en esta ventana"
          description="La ventana del último conteo aplicado no dejó ninguna diferencia que prorratear."
        />
      ) : (
        <>
          {data.insufficient_sample ? (
            <p className="sin-dato px-2 py-1.5 text-sm not-italic" data-muestra="chica" role="note">
              {/* El motivo del servidor ya empieza por «Muestra insuficiente: …»: se muestra tal cual. */}
              {data.insufficient_sample_reason ?? (
                <>
                  <span className="font-medium">Muestra chica</span>: tomá el reparto como indicio, no como cifra firme.
                </>
              )}
            </p>
          ) : null}

          {/* Sin total valorizado no hay titular que concluya ni barras que dibujar: queda la tabla. */}
          {data.total_variance_value === null || data.total_variance_value === undefined ? null : (
            <div className="rounded-lg border bg-card p-4">
              <ChartFrame
                titular={varianceByDishTitular(data)}
                detalle="Varianza estimada por plato con el cero al centro, en pesos. A la derecha, faltante (se usó más insumo del que explican las ventas); a la izquierda, sobrante. Faltantes primero."
                muestra={
                  data.sales_in_window === null || data.sales_in_window === undefined
                    ? undefined
                    : {
                        n: data.sales_in_window,
                        unidad: data.sales_in_window === 1 ? "comanda" : "comandas",
                        ventana,
                        // Si la muestra es chica lo decide el SERVIDOR (ventana y comandas, con su
                        // motivo, arriba): el marco sólo dice la base, no aplica un umbral propio.
                        minimo: 0,
                      }
                }
                tabla={{
                  columnas: [
                    { key: "plato", header: "Plato" },
                    { key: "que", header: "Qué pasó" },
                    { key: "valor", header: "Real − teórico", align: "right" },
                  ],
                  filas: rows.map((r) => ({
                    plato: r.product_name ?? `#${r.product_id}`,
                    que: <Direccion row={r} />,
                    valor: r.variance_value === null || r.variance_value === undefined ? "Sin datos" : formatCOP(r.variance_value),
                  })),
                }}
              >
                {/* La cifra de la barra va SIN signo: el lado, el color, la flecha y la palabra ya dicen la
                    dirección, y «−$ … sobrante» era una doble negación (analista #11). El signo del
                    servidor queda en la tabla, en «Real − teórico». Quitar el «-» del texto no es una cuenta. */}
                <DivergingBars
                  datos={datos}
                  formato={(v) => formatCOP(v).replace(/^[-−]/, "")}
                  faltaCuando="positivo"
                  resumen={`${varianceByDishTitular(data)}. ${rows.length} platos; el detalle está en la tabla.`}
                />
              </ChartFrame>
            </div>
          )}

          <DenseTable
            caption="Varianza estimada por plato sobre la ventana del último conteo aplicado."
            columns={VARIANCE_COLUMNS}
            rows={rows}
            rowKey={(r) => String(r.product_id)}
            maxBodyHeightPx={460}
            bar={<DenseTableBar shown={rows.length} total={rows.length} noun="platos con varianza estimada" />}
            legend={[
              {
                term: "Real − teórico",
                meaning: "positivo = se usó más insumo del que explican las ventas (faltante); negativo = se contó de más (sobrante).",
              },
              {
                term: "Peso del prorrateo",
                meaning: "qué parte del costo teórico de los insumos con varianza explica este plato. No es su culpa: es su porción.",
              },
              {
                term: "Varianza ≠ robo",
                meaning: "es la diferencia entre lo que la ficha dice que debió salir y lo que el conteo encontró. Merma, porción y error de registro entran igual.",
              },
            ]}
          />
          {data.unattributed_variance_value !== null && data.unattributed_variance_value !== undefined && data.unattributed_variance_value !== 0 ? (
            <p className="text-xs text-muted-foreground">
              {formatCOP(data.unattributed_variance_value)} de varianza no se pudo atribuir a ningún plato en
              esta ventana (consumo sin movimiento de venta rastreable a un ítem).
            </p>
          ) : null}
        </>
      )}
    </div>
  )
}

export default VarianceByDishTab
