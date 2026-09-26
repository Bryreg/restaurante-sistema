import { useQuery } from "@tanstack/react-query"
import { ArrowLeft } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import { getIngredientMovements, type MovementCause, type StockMovementOut } from "@/api/inventory"
import { getIngredientRecord, type IngredientCauseTotalOut, type IngredientCountLineOut } from "@/api/panel"
import { PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCantidad } from "@/lib/format"

import { areaCountHref } from "@/features/inventory/areaCountLib"
import { CAUSE_LABEL } from "@/features/inventory/lib"

import { PersonaLink, SeccionFicha } from "./comun"

const MOMENT_LABEL: Record<string, string> = { opening: "Apertura", closing: "Cierre", spot: "Recuento" }

function causeLabel(cause: string): string {
  return CAUSE_LABEL[cause as MovementCause] ?? cause
}

/**
 * **Ficha de un insumo**: su stock según el libro, lo que entró y salió en
 * el período por causa (compra, venta, merma, producción, conteo,
 * traslado), sus conteos por área (cada uno lleva al conteo) y el libro
 * movimiento por movimiento, con quién lo hizo. Las sumas por causa las
 * hace el servidor sobre el libro de movimientos, que es el único asiento
 * del inventario; acá sólo se escriben.
 */
export function FichaInsumo(): React.JSX.Element {
  const { ingredientId: raw } = useParams()
  const ingredientId = Number(raw)
  const valido = Number.isInteger(ingredientId) && ingredientId > 0
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")

  const record = useQuery({
    queryKey: ["admin-record-ingredient", ingredientId, from, to],
    queryFn: () => getIngredientRecord(ingredientId, { from: from || undefined, to: to || undefined }),
    enabled: valido,
  })
  const r = record.data
  const movements = useQuery({
    queryKey: ["admin-ingredient-movements", ingredientId, r?.date_from, r?.date_to],
    queryFn: () => getIngredientMovements({ ingredientId, from: r?.date_from, to: r?.date_to }),
    // Sin inventario perpetuo no hay libro: el servidor contestaría que la función está apagada.
    enabled: valido && r !== undefined && r.stock !== null,
  })

  if (!valido) {
    return <EmptyState reason="dependency" title="Ese insumo no existe" description="La dirección no nombra un insumo." />
  }
  if (record.isLoading) return <Cargando texto="Cargando la ficha del insumo…" />
  if (record.isError || !r) {
    return (
      <EmptyState
        reason="error"
        title="No se pudo cargar la ficha del insumo"
        description={errorMessage(record.error)}
        action={{ label: "Reintentar", onClick: () => void record.refetch() }}
      />
    )
  }

  const unit = r.base_unit === "unit" ? "und" : r.base_unit
  const byCauseColumns: readonly DenseColumn<IngredientCauseTotalOut>[] = [
    { key: "cause", header: "Causa", kind: "name", cell: (c) => causeLabel(c.cause) },
    { key: "n", header: "Movimientos", kind: "number", cell: (c) => c.movements },
    { key: "qty", header: "Cantidad neta", kind: "number", cell: (c) => formatCantidad(c.qty, unit) },
  ]
  const countColumns: readonly DenseColumn<IngredientCountLineOut>[] = [
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
    { key: "qty", header: "Contado", kind: "number", cell: (c) => formatCantidad(c.qty, unit) },
    { key: "who", header: "Contó", cell: (c) => c.employee_name },
    { key: "at", header: "Cuándo", cell: (c) => formatInstant(c.counted_at) },
  ]
  const movementColumns: readonly DenseColumn<StockMovementOut>[] = [
    { key: "at", header: "Cuándo", cell: (m) => formatInstant(m.at) },
    { key: "cause", header: "Causa", cell: (m) => causeLabel(m.cause) },
    { key: "qty", header: "Cantidad", kind: "number", cell: (m) => formatCantidad(m.qty_base, unit) },
    { key: "who", header: "Quién", cell: (m) => <PersonaLink id={m.employee_id} name={m.employee_name} /> },
    { key: "note", header: "Nota", kind: "secondary", secondary: true, cell: (m) => m.note ?? "—" },
  ]

  return (
    <div className="space-y-5">
      <PageHeader
        name={r.name}
        question="Qué le pasó a este insumo en el período: cuánto hay según el libro, qué entró y qué salió por cada causa, y cómo lo contaron."
        context={[
          { label: "Estado", value: r.active ? "Activo" : "Inactivo" },
          { label: "Período", value: `${formatBusinessDate(r.date_from)} a ${formatBusinessDate(r.date_to)}` },
        ]}
        actions={
          <Button variant="outline" size="sm" nativeButton={false} title="Volver a Inventario" render={<Link to="/admin/inventario" />}>
            <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            Volver a Inventario
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="ficha-insumo-desde">Desde</Label>
          <Input id="ficha-insumo-desde" type="date" className="h-9" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="ficha-insumo-hasta">Hasta</Label>
          <Input id="ficha-insumo-hasta" type="date" className="h-9" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {r.stock === null ? (
          <StatTile label="Stock según el libro" value={null} nullNote="El inventario perpetuo está apagado en esta sede." />
        ) : (
          <StatTile
            label="Stock según el libro"
            value={formatCantidad(r.stock, unit)}
            tone={Number(r.stock) < 0 ? "critical" : "default"}
            hint={Number(r.stock) < 0 ? "En negativo: deuda de registro, no escasez real." : undefined}
            link={{ to: "/admin/inventario?tab=stock", screen: "Inventario", tab: "Stock" }}
          />
        )}
        <StatTile label="Conteos por área" value={String(r.area_counts.length)} />
      </div>

      <SeccionFicha
        titulo="Entradas y salidas por causa"
        dice="la suma del libro en el período, causa por causa"
        sustantivo="causas"
        vacio={r.stock === null ? "Sin inventario perpetuo no hay libro de movimientos." : "No hubo movimientos en el período."}
        columns={byCauseColumns}
        rows={r.by_cause}
        rowKey={(c) => c.cause}
      />
      <SeccionFicha
        titulo="Conteos por área"
        dice="cuánto contaron, dónde y quién"
        sustantivo="conteos"
        vacio="Nadie lo contó por área en el período."
        columns={countColumns}
        rows={r.area_counts}
        rowKey={(c) => `${c.count_id}`}
      />
      {r.stock !== null ? (
        movements.isLoading ? (
          <Cargando texto="Cargando el libro…" />
        ) : movements.isError ? (
          <EmptyState
            reason="error"
            title="No se pudo cargar el libro de movimientos"
            description={errorMessage(movements.error)}
            action={{ label: "Reintentar", onClick: () => void movements.refetch() }}
          />
        ) : (
          <SeccionFicha
            titulo="Libro de movimientos"
            dice="cada entrada y salida, con quién la hizo"
            sustantivo="movimientos"
            vacio="No hubo movimientos en el período."
            columns={movementColumns}
            rows={movements.data ?? []}
            rowKey={(m) => String(m.id)}
          />
        )
      ) : null}
    </div>
  )
}

export default FichaInsumo
