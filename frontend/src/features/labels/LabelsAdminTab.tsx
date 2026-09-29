import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import { csvUrl } from "@/api/client"
import {
  getAdminLabelSettings,
  listAdminLabels,
  putAdminLabelSettings,
  type FoodLabel,
  type LabelFilter,
  type LabelSettings,
} from "@/api/labels"
import { DenseTable, DenseTableBar, type DenseColumn, type LegendEntry, type RowStatus } from "@/components/admin"
import { CsvExportButton } from "@/components/CsvExportButton"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"

import { SOURCE_TEXT, stateText } from "./lib"
import { codeText, KIND_LABEL } from "./printLabels"

const FILTER_LABEL: Record<LabelFilter, string> = {
  active: "En la cocina",
  closed: "Cerradas",
  all: "Todas",
}

const LEGEND: readonly LegendEntry[] = [
  { term: "Vencida", meaning: "sigue en la cocina con la fecha pasada: hay que botarla (queda como merma, con PIN)." },
  { term: "Vence hoy / mañana", meaning: "se usa primero." },
]

/** Los tamaños de rollo más comunes, para no tener que medir. */
const PRESETS: { label: string; width: number; height: number }[] = [
  { label: "50 × 30 mm", width: 50, height: 30 },
  { label: "40 × 30 mm", width: 40, height: 30 },
  { label: "58 × 40 mm", width: 58, height: 40 },
  { label: "62 × 29 mm", width: 62, height: 29 },
]

/**
 * Inventario › Etiquetas: qué hay etiquetado en la cocina, lo cerrado (se
 * acabó / se botó) y el tamaño del rollo de la impresora. Nada se imprime
 * desde acá: se imprime en la tablet de la cocina.
 */
export function LabelsAdminTab({ storeId }: { storeId: number }): React.JSX.Element {
  const [filter, setFilter] = useState<LabelFilter>("active")
  const query = useQuery({
    queryKey: ["labels", "admin", storeId, filter],
    queryFn: () => listAdminLabels({ store_id: storeId, status: filter }),
  })
  const rows = query.data ?? []
  const expired = rows.filter((r) => r.status === "active" && r.state === "expired").length

  function statusOf(l: FoodLabel): RowStatus {
    if (l.status !== "active") return "none"
    if (l.state === "expired") return "critical"
    if (l.state === "today" || l.state === "tomorrow") return "warning"
    return "none"
  }

  const columns: readonly DenseColumn<FoodLabel>[] = [
    { key: "item", header: "Producto", kind: "name", cell: (l) => l.item_name },
    { key: "kind", header: "Tipo", cell: (l) => KIND_LABEL[l.kind] },
    {
      key: "use_by",
      header: "Usar antes de",
      cell: (l) => (l.status === "active" ? stateText(l) : l.use_by ? formatFechaCorta(l.use_by) : "Sin vencimiento"),
    },
    { key: "lot", header: "Lote", kind: "id", cell: (l) => l.lot_code ?? "—" },
    { key: "who", header: "Hizo", kind: "secondary", cell: (l) => l.employee_name },
    { key: "made", header: "Hecha", kind: "secondary", secondary: true, cell: (l) => formatInstant(l.made_at) },
    {
      key: "source",
      header: "La fecha sale de",
      kind: "secondary",
      secondary: true,
      cell: (l) => (l.use_by_source ? SOURCE_TEXT[l.use_by_source] : "—"),
    },
    {
      key: "status",
      header: "Estado",
      cell: (l) =>
        l.status === "active"
          ? "En la cocina"
          : `${l.status === "used_up" ? "Se acabó" : "Se botó"} · ${l.closed_by_employee_name ?? ""}`,
    },
    { key: "code", header: "Código", kind: "id", secondary: true, cell: (l) => codeText(l.code) },
  ]

  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudieron cargar las etiquetas"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }

  return (
    <div className="space-y-6">
      <DenseTable
        caption="Etiquetas de cocina"
        columns={columns}
        rows={rows}
        rowKey={(l) => String(l.id)}
        rowStatus={statusOf}
        rowInactive={(l) => l.status !== "active"}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={rows.length}
            total={rows.length}
            noun="etiquetas"
            hidden={query.isLoading ? "contando…" : expired > 0 ? `${expired} vencidas en la cocina` : undefined}
          >
            <div className="flex items-center gap-2">
              <Label htmlFor="labels-filter">Mostrar</Label>
              <Select value={filter} onValueChange={(v) => setFilter(v as LabelFilter)}>
                <SelectTrigger id="labels-filter" className="h-8 w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FILTER_LABEL) as LabelFilter[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {FILTER_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <CsvExportButton href={csvUrl("/admin/labels", { store_id: storeId, status: filter })} />
          </DenseTableBar>
        }
        note={
          <>
            Se imprimen en la tablet de la cocina (<b>Etiquetas</b>): al abrir un empaque, al recibir y al producir. El
            «usar antes de» lo calcula el sistema con los <b>días que dura abierto</b> de cada insumo (se ponen en
            Insumos) y el vencimiento del lote.
          </>
        }
        empty={
          query.isLoading ? undefined : (
            <EmptyState
              title={filter === "active" ? "No hay etiquetas en la cocina" : "Sin etiquetas"}
              description="Las etiquetas se imprimen desde la tablet de la cocina, en la pantalla Etiquetas."
            />
          )
        }
      />
      <LabelSizeCard storeId={storeId} />
    </div>
  )
}

function LabelSizeCard({ storeId }: { storeId: number }) {
  const query = useQuery({ queryKey: ["labels", "settings", storeId], queryFn: () => getAdminLabelSettings(storeId) })
  if (!query.data) return null
  return <LabelSizeForm key={storeId} storeId={storeId} initial={query.data} />
}

function LabelSizeForm({ storeId, initial }: { storeId: number; initial: LabelSettings }) {
  const queryClient = useQueryClient()
  const [width, setWidth] = useState(String(initial.width_mm))
  const [height, setHeight] = useState(String(initial.height_mm))

  const save = useMutation({
    mutationFn: () => putAdminLabelSettings(storeId, { width_mm: Number(width), height_mm: Number(height) }),
    onSuccess: () => {
      toast.success("Tamaño de etiqueta guardado")
      void queryClient.invalidateQueries({ queryKey: ["labels", "settings", storeId] })
    },
    onError: (err) => toast.error(errorMessage(err)),
  })

  const w = Number(width)
  const h = Number(height)
  const valid = w >= 25 && w <= 120 && h >= 15 && h <= 120

  return (
    <section className="max-w-xl space-y-3 rounded-lg border bg-card p-4" aria-labelledby="label-size-title">
      <div>
        <h2 id="label-size-title" className="text-base font-bold">
          Tamaño del rollo de etiquetas
        </h2>
        <p className="text-sm text-muted-foreground">
          El ancho y el alto de UNA etiqueta, en milímetros, como dice la caja del rollo.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tamaños comunes">
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            type="button"
            size="sm"
            variant={w === p.width && h === p.height ? "default" : "outline"}
            aria-pressed={w === p.width && h === p.height}
            onClick={() => {
              setWidth(String(p.width))
              setHeight(String(p.height))
            }}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label htmlFor="label-width">Ancho (mm)</Label>
          <Input id="label-width" type="number" min={25} max={120} value={width} onChange={(e) => setWidth(e.target.value)} className="w-28" />
        </div>
        <div>
          <Label htmlFor="label-height">Alto (mm)</Label>
          <Input id="label-height" type="number" min={15} max={120} value={height} onChange={(e) => setHeight(e.target.value)} className="w-28" />
        </div>
        <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          Guardar tamaño
        </Button>
      </div>
      {!valid && width !== "" ? (
        <p className="text-sm text-destructive">El ancho va de 25 a 120 mm y el alto de 15 a 120 mm.</p>
      ) : null}
    </section>
  )
}
