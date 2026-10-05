import { useQuery } from "@tanstack/react-query"
import { ArrowLeft, Package, RotateCcw, SlidersHorizontal } from "lucide-react"
import { useState } from "react"
import { Link, useParams } from "react-router-dom"

import { getIngredientMovements, type MovementCause, type StockMovementOut } from "@/api/inventory"
import {
  getIngredientRecord,
  type IngredientCountLineOut,
  type IngredientRecordOut,
  type StockByDaySeriesOut,
} from "@/api/panel"
import { useSession } from "@/app/session"
import { PageHeader, type DenseColumn } from "@/components/admin"
import { Cargando } from "@/components/Cargando"
import { BarrasConReferencia, DivergingBars, type RenglonResumen } from "@/components/charts"
import { EmptyState } from "@/components/EmptyState"
import { StatTile } from "@/components/StatTile"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCantidad, formatFechaCorta } from "@/lib/format"

import { AdjustmentDialog } from "@/features/inventory/AdjustmentDialog"
import { RecountDialog } from "@/features/inventory/RecountDialog"
import { areaCountHref } from "@/features/inventory/areaCountLib"
import { CAUSE_LABEL } from "@/features/inventory/lib"

import { AvatarFicha, DetallePlegable, FilaDeTarjetas, PersonaLink, PreguntaFicha, SeccionFicha } from "./comun"
import { CsvExportButton } from "@/components/CsvExportButton"
import { csvUrl } from "@/api/client"

const MOMENT_LABEL: Record<string, string> = { opening: "Apertura", closing: "Cierre", spot: "Recuento" }

function causeLabel(cause: string): string {
  return CAUSE_LABEL[cause as MovementCause] ?? cause
}

/** «hoy» para el día en curso; si no, el número del día (el mes ya lo dice el título del globo). */
function rotuloDia(label: string, now: boolean): string {
  if (now) return "hoy"
  return label.split(" ")[1] ?? label
}

/**
 * «¿Cuándo se me acaba?» (handoff, ficha de insumo): el stock según el libro
 * al cierre de los últimos 14 días y 7 proyectados al 35 %, contra el
 * mínimo. Cada punto, su lado de la raya y las fechas del resumen vienen del
 * servidor (`stock_by_day`); pasar el texto decimal a número es sólo para
 * dibujarlo.
 */
function CuandoSeAcaba({ serie, unidad }: { serie: StockByDaySeriesOut; unidad: string }): React.JSX.Element {
  const minimo = formatCantidad(serie.min_stock, unidad)
  const resumen: RenglonResumen[] = []
  const hoy = serie.points.find((p) => p.now)?.business_date
  if (serie.runs_out_on) {
    resumen.push({
      titulo: `Se acaba el ${formatFechaCorta(serie.runs_out_on)}`,
      detalle: `Con el consumo de siempre (${formatCantidad(serie.daily_use, unidad)} por día), la proyección llega a cero ese día.`,
      tono: "warning",
    })
  }
  if (serie.below_min_on) {
    const yaPaso = hoy !== undefined && serie.below_min_on < hoy
    resumen.push(
      yaPaso
        ? {
            titulo: `En el mínimo o debajo desde el ${formatFechaCorta(serie.below_min_on)}`,
            detalle: "Falta comprar: el libro ya lo muestra bajo la raya.",
            tono: "warning",
          }
        : {
            titulo: `Llega al mínimo el ${formatFechaCorta(serie.below_min_on)}`,
            detalle: "Conviene pedir antes de ese día.",
            tono: "warning",
          },
    )
  } else {
    resumen.push({
      titulo: "No llega al mínimo en 7 días",
      detalle: serie.daily_use
        ? `Con el consumo de siempre alcanza la semana proyectada.`
        : "No tuvo consumo en los últimos 14 días: no hay nada que proyectar.",
      tono: "success",
    })
  }
  if (serie.daily_use) {
    resumen.push({
      titulo: `Consume ${formatCantidad(serie.daily_use, unidad)} por día`,
      detalle: "Promedio de venta, producción y merma de los últimos 14 días cerrados. Las compras no se proyectan.",
      tono: "data",
    })
  }
  // Mirar si algún día quedó en positivo es comparar, no calcular.
  const sinStock = serie.points.every((p) => p.qty === null || Number(p.qty) <= 0)
  return (
    <PreguntaFicha titulo="¿Cuándo se me acaba?">
      {!serie.available ? (
        <p className="sin-dato sin-dato--calmo text-sm">{serie.reason ?? "No se pudo leer el stock por día."}</p>
      ) : (
        <>
          <BarrasConReferencia
            pregunta="Stock al cierre de cada día y lo que viene si se consume igual"
            variante="columnas"
            malo="debajo"
            alto={170}
            referenciaComun={Number(serie.min_stock)}
            formato={(v) => formatCantidad(v, unidad)}
            leyenda={{ barra: "Stock al cierre de cada día", fuera: "En el mínimo o debajo", raya: `Mínimo: ${minimo}` }}
            puntos={serie.points.map((p) => ({
              key: p.key,
              etiqueta: rotuloDia(p.label, p.now),
              valor: p.qty === null ? null : Number(p.qty),
              fuera: p.outside,
              futuro: p.future,
              ahora: p.now,
              cifra: "",
              detalle: undefined,
            }))}
            rotuloResumen="Lo que conviene"
            resumen={resumen}
            // El libro en negativo (o en cero) todos los días: no hay barra
            // que dibujar, y una fila de ▼ sobre un eje vacío no decía nada.
            vacio={
              sinStock
                ? "El libro no tiene stock positivo en ninguno de estos días: no hay barras que dibujar. Un conteo lo corrige."
                : null
            }
          />
          {sinStock ? null : (
            <p className="text-xs text-muted-foreground">
              Las barras claras son la proyección: lo que viene si se consume igual que los últimos 14 días.
            </p>
          )}
        </>
      )}
    </PreguntaFicha>
  )
}

/**
 * **Ficha de un insumo** (handoff del panel, pantalla 10 · insumo): cabecera
 * con su ícono y contexto, cuatro tarjetas (stock según el libro, consumo
 * diario, cuándo llega al mínimo, conteos por área), «¿Cuándo se me acaba?»
 * y «Entradas y salidas por causa» (barras divergentes: salidas en
 * `--diverge-falta`, entradas en `--data-1`), y plegado el detalle con los
 * conteos por área y el libro movimiento por movimiento. Las sumas por causa
 * las hace el servidor sobre el libro de movimientos, que es el único asiento
 * del inventario; acá sólo se escriben.
 */
export function FichaInsumo(): React.JSX.Element {
  const { ingredientId: raw } = useParams()
  const ingredientId = Number(raw)
  const valido = Number.isInteger(ingredientId) && ingredientId > 0
  const { hasFeature } = useSession()
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [ajustar, setAjustar] = useState(false)
  const [recontar, setRecontar] = useState(false)

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
    <div className="space-y-[18px]">
      <Link
        to="/admin/inventario?tab=stock"
        title="Volver a Inventario"
        className="inline-flex items-center gap-1.5 text-[13px] text-primary hover:underline"
      >
        <ArrowLeft className="size-3.5 shrink-0" aria-hidden="true" />
        Volver a Inventario › Stock
      </Link>
      <div className="flex items-start gap-3.5">
        <AvatarFicha forma="cosa" icono={Package} />
        <PageHeader
          className="min-w-0 flex-1"
          name={r.name}
          question="Qué le pasó a este insumo en el período: cuánto hay según el libro, cuándo se acaba, qué entró y qué salió por cada causa, y cómo lo contaron."
          context={[
            { label: r.active ? "Activo" : "Inactivo" },
            { label: "Unidad base", value: unit },
            { label: "Período", value: `${formatBusinessDate(r.date_from)} a ${formatBusinessDate(r.date_to)}` },
          ]}
          actions={
            <>
              {r.stock !== null ? (
                <>
                  <Button type="button" variant="outline" size="sm" onClick={() => setAjustar(true)}>
                    <SlidersHorizontal className="size-4 shrink-0" aria-hidden="true" />
                    Ajustar con motivo
                  </Button>
                  {hasFeature("inventory.shift_counts") ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setRecontar(true)}>
                      <RotateCcw className="size-4 shrink-0" aria-hidden="true" />
                      Pedir recuento
                    </Button>
                  ) : null}
                </>
              ) : null}
              <CsvExportButton
                href={csvUrl(`/admin/records/ingredient/${ingredientId}`, { from: from || undefined, to: to || undefined })}
                label="Descargar la ficha"
              />
            </>
          }
        />
      </div>

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

      <TarjetasInsumo r={r} unit={unit} />

      {r.stock_by_day ? <CuandoSeAcaba serie={r.stock_by_day} unidad={unit} /> : null}

      <PreguntaFicha titulo={`Entradas y salidas por causa · ${formatBusinessDate(r.date_from)} a ${formatBusinessDate(r.date_to)}`}>
        {r.by_cause.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            {r.stock === null ? "Sin inventario perpetuo no hay libro de movimientos." : "No hubo movimientos en el período."}
          </p>
        ) : (
          <div className="rounded-lg border bg-card px-3.5 py-2.5">
            <DivergingBars
              enLinea
              colorSobra="var(--data-1)"
              palabras={{ falta: "salida", sobra: "entrada", cero: "sin cambio" }}
              datos={r.by_cause.map((c) => ({ key: c.cause, etiqueta: `${causeLabel(c.cause)} · ${c.movements} mov.`, valor: Number(c.qty) }))}
              formato={(v) => formatCantidad(v, unit)}
              resumen={`Entradas y salidas del libro por causa en el período: ${r.by_cause
                .map((c) => `${causeLabel(c.cause)} ${formatCantidad(c.qty, unit)}`)
                .join("; ")}.`}
            />
          </div>
        )}
      </PreguntaFicha>

      <DetallePlegable texto="Ver conteos y libro de movimientos">
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
              ancha
            />
          )
        ) : null}
      </DetallePlegable>

      {ajustar ? (
        <AdjustmentDialog
          storeId={r.store_id}
          ingredients={[{ id: r.ingredient_id, name: r.name }]}
          initialIngredientId={r.ingredient_id}
          open
          onOpenChange={(open) => {
            if (!open) setAjustar(false)
          }}
          showTrigger={false}
        />
      ) : null}
      {recontar ? (
        <RecountDialog
          storeId={r.store_id}
          ingredientId={r.ingredient_id}
          open
          onOpenChange={(open) => {
            if (!open) setRecontar(false)
          }}
          showTrigger={false}
        />
      ) : null}
    </div>
  )
}

/** Las cuatro tarjetas de la ficha de insumo, con tono sólo donde lleva a algún lado. */
function TarjetasInsumo({ r, unit }: { r: IngredientRecordOut; unit: string }): React.JSX.Element {
  const serie = r.stock_by_day
  // El último día cerrado con libro: si quedó en el mínimo o debajo lo dice el servidor (`outside`).
  const ultimoCerrado = serie?.points.filter((p) => !p.future && p.qty !== null).at(-1)
  const negativo = r.stock !== null && r.stock.trim().startsWith("-")
  return (
    <FilaDeTarjetas>
      {r.stock === null ? (
        <StatTile label="Stock según el libro" value={null} nullNote="El inventario perpetuo está apagado en esta sede." />
      ) : (
        <StatTile
          label="Stock según el libro"
          value={formatCantidad(r.stock, unit)}
          tone={negativo ? "critical" : ultimoCerrado?.outside ? "warning" : "default"}
          hint={
            negativo
              ? "En negativo: deuda de registro, no escasez real."
              : serie
                ? `Mínimo ${formatCantidad(serie.min_stock, unit)}`
                : undefined
          }
          link={{ to: "/admin/inventario?tab=stock", screen: "Inventario", tab: "Stock" }}
        />
      )}
      {serie?.daily_use ? (
        <StatTile
          label="Consumo diario"
          value={formatCantidad(serie.daily_use, unit)}
          hint="venta, producción y merma · promedio de 14 días cerrados"
        />
      ) : (
        <StatTile
          label="Consumo diario"
          value={null}
          nullNote={serie && !serie.available ? (serie.reason ?? "Sin libro.") : "Sin consumo en los últimos 14 días cerrados. No es cero: no hubo con qué promediar."}
        />
      )}
      {serie && serie.available ? (
        serie.below_min_on ? (
          <StatTile
            label={
              serie.points.some((p) => p.now && p.business_date > serie.below_min_on!)
                ? "Bajo el mínimo desde"
                : "Llega al mínimo"
            }
            value={formatFechaCorta(serie.below_min_on)}
            tone="warning"
            hint={serie.runs_out_on ? `Se acaba el ${formatFechaCorta(serie.runs_out_on)} si no entra nada` : "La proyección no llega a cero en 7 días"}
            link={{ to: "/admin/compras", screen: "Compras" }}
          />
        ) : (
          <StatTile label="Llega al mínimo" value="No en 7 días" hint="Con el consumo de siempre alcanza la semana proyectada." />
        )
      ) : (
        <StatTile label="Llega al mínimo" value={null} nullNote="Sin libro no hay proyección." />
      )}
      <StatTile label="Conteos por área" value={String(r.area_counts.length)} hint="en el período" />
    </FilaDeTarjetas>
  )
}

export default FichaInsumo
