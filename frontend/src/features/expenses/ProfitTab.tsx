/**
 * Admin → Obligaciones y gastos → Utilidad del período (T2,
 * `GET /admin/profit`): ventas netas, costo, gastos, obligaciones y nómina,
 * hasta `profit`. Todos los números YA vienen sumados por el servidor —
 * ninguna resta acá (AGENTS.md § "una sola matemática, en el backend").
 * `available`/`reason` mandan igual que en punto de equilibrio.
 */
import { useQuery } from "@tanstack/react-query"
import { useState } from "react"

import { getProfit } from "@/api/expenses"
import { HeadlineFigure } from "@/components/admin"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { daysAgoLocal, todayLocal } from "./lib"

export function ProfitTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(30))
  const [to, setTo] = useState(todayLocal())

  const query = useQuery({
    queryKey: ["expenses", "profit", storeId, from, to],
    queryFn: () => getProfit({ storeId, from, to }),
  })

  return (
    <div className="space-y-4">
      <DateRangeFilter
        idPrefix="profit"
        from={from}
        to={to}
        onChange={(r) => {
          setFrom(r.from)
          setTo(r.to)
        }}
      />

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Calculando la utilidad del período…</p>
      ) : query.isError ? (
        <EmptyState
          role="alert"
          title="No se pudo calcular la utilidad"
          description={errorMessage(query.error)}
          action={{ label: "Reintentar", onClick: () => void query.refetch() }}
        />
      ) : !query.data?.available ? (
        <EmptyState
          title="Utilidad no disponible"
          description={query.data?.reason ?? "Faltan datos del período para calcularla."}
        />
      ) : (
        /* Patrón 4 · Banda de cifra: la utilidad NO es un número suelto al
           lado de otros cinco, es la resta de los cinco. Seis tarjetas
           iguales aplanaban la ecuación —«nómina» y «utilidad» no son el
           mismo tipo de número— y dejaban al dueño reconstruyendo la cuenta
           de cabeza. Acá el libro la muestra hecha; el servidor sigue siendo
           el único que la calcula. */
        <HeadlineFigure
          label="Utilidad del período"
          value={formatCOP(query.data.profit)}
          note="lo que queda después de todo lo que costó tener abierto"
          ledger={{
            rows: [
              { label: "Ventas netas", value: formatCOP(query.data.net_sales) },
              { label: "Costo de lo vendido", value: formatCOP(query.data.cost), kind: "subtract" },
              { label: "Gastos", value: formatCOP(query.data.expenses), kind: "subtract" },
              { label: "Obligaciones", value: formatCOP(query.data.obligations), kind: "subtract" },
              { label: "Nómina", value: formatCOP(query.data.payroll), kind: "subtract" },
            ],
            total: { label: "Utilidad", value: formatCOP(query.data.profit) },
          }}
        />
      )}
    </div>
  )
}

export default ProfitTab
