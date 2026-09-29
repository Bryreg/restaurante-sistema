import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Minus, Plus, Printer, Tag } from "lucide-react"
import { useId, useMemo, useRef, useState } from "react"
import { useSearchParams } from "react-router-dom"
import { toast } from "sonner"

import { useSession } from "@/app/session"
import { newIdempotencyKey } from "@/api/client"
import {
  createLabels,
  getDeviceLabelSettings,
  getLabelBoard,
  getLabelByCode,
  getLabelSources,
  type FoodLabel,
  type LabelCreateIn,
  type UseBySource,
} from "@/api/labels"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatClockTime } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatFechaCorta } from "@/lib/format"
import { cn } from "@/lib/utils"

import { LabelSheet } from "./LabelSheet"
import { fold, SOURCE_TEXT, stateText, stateTone } from "./lib"
import { codeText, KIND_LABEL, printLabels, type LabelSize } from "./printLabels"
import { ScanBox } from "./ScanBox"

type TabKey = "cocina" | "abri" | "recibi" | "produje"
const TABS: readonly TabKey[] = ["cocina", "abri", "recibi", "produje"]
const DEFAULT_SIZE: LabelSize = { width_mm: 50, height_mm: 30 }
const MAX_COPIES = 30

/**
 * Etiquetas de cocina (`inventory.labels`). Tres maneras de imprimir —
 * «Abrí algo», «Recibí» y «Produje»— y una lista de lo que está en la
 * cocina, lo que vence primero arriba. El «usar antes de» lo calcula el
 * servidor; acá sólo se ve, y se puede acortar.
 */
export function LabelsPage(): React.JSX.Element {
  const { hasFeature } = useSession()
  const enabled = hasFeature("inventory.labels")
  const [params, setParams] = useSearchParams()
  const tabParam = params.get("tab") as TabKey | null
  const tab: TabKey = tabParam && TABS.includes(tabParam) ? tabParam : "cocina"
  const [sheet, setSheet] = useState<FoodLabel | null>(null)

  const settingsQuery = useQuery({
    queryKey: ["device", "labels", "settings"],
    queryFn: getDeviceLabelSettings,
    enabled,
    staleTime: 5 * 60_000,
  })
  const size = settingsQuery.data ?? DEFAULT_SIZE

  const boardQuery = useQuery({
    queryKey: ["device", "labels", "board"],
    queryFn: getLabelBoard,
    enabled,
    refetchInterval: 30_000,
  })

  const scan = useMutation({
    mutationFn: getLabelByCode,
    onSuccess: (label) => setSheet(label),
    onError: (err) => toast.error(errorMessage(err)),
  })

  if (!enabled) {
    return (
      <div className="p-4">
        <EmptyState
          reason="feature-off"
          title="Las etiquetas están apagadas"
          description="El administrador las enciende en Ajustes › Funciones (Etiquetas de cocina)."
        />
      </div>
    )
  }

  const board = boardQuery.data

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Tag className="size-6" aria-hidden />
            Etiquetas
          </h1>
          <p className="text-sm text-muted-foreground">
            Todo lo abierto, recibido o producido va con su etiqueta y su «usar antes de».
          </p>
        </div>
        {board ? (
          <p className="text-sm" aria-live="polite">
            {board.expired > 0 ? (
              <span className="font-bold text-destructive">{board.expired} vencida(s) en la cocina · </span>
            ) : null}
            {board.today > 0 ? <span className="font-bold">{board.today} vencen hoy · </span> : null}
            {board.labels.length} activa(s)
          </p>
        ) : null}
      </header>

      <ScanBox onCode={(code) => scan.mutate(code)} busy={scan.isPending} />

      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = new URLSearchParams(params)
          next.set("tab", String(value))
          next.delete("lote")
          setParams(next, { replace: true })
        }}
      >
        <TabsList className="h-auto w-full flex-wrap">
          <TabsTrigger value="cocina" className="min-h-11 flex-1">
            En la cocina
          </TabsTrigger>
          <TabsTrigger value="abri" className="min-h-11 flex-1">
            Abrí algo
          </TabsTrigger>
          <TabsTrigger value="recibi" className="min-h-11 flex-1">
            Recibí
          </TabsTrigger>
          <TabsTrigger value="produje" className="min-h-11 flex-1">
            Produje
          </TabsTrigger>
        </TabsList>
        <TabsContent value="cocina" className="pt-3">
          <BoardList loading={boardQuery.isLoading} error={boardQuery.error} labels={board?.labels ?? []} onOpen={setSheet} />
        </TabsContent>
        <TabsContent value="abri" className="pt-3">
          <SourcesTab kind="abri" size={size} />
        </TabsContent>
        <TabsContent value="recibi" className="pt-3">
          <SourcesTab kind="recibi" size={size} />
        </TabsContent>
        <TabsContent value="produje" className="pt-3">
          <SourcesTab kind="produje" size={size} initialBatch={Number(params.get("lote")) || null} />
        </TabsContent>
      </Tabs>

      <LabelSheet label={sheet} size={size} onClose={() => setSheet(null)} />
    </div>
  )
}

function BoardList({
  loading,
  error,
  labels,
  onOpen,
}: {
  loading: boolean
  error: unknown
  labels: FoodLabel[]
  onOpen: (label: FoodLabel) => void
}) {
  if (loading) return <Skeleton className="h-40 w-full" />
  if (error) return <EmptyState reason="error" title="No se pudo cargar" description={errorMessage(error)} role="alert" />
  if (labels.length === 0) {
    return (
      <EmptyState
        title="No hay etiquetas activas"
        description="Cuando abras, recibas o produzcas algo, imprimí su etiqueta en las otras pestañas."
      />
    )
  }
  return (
    <ul className="divide-y rounded-lg border bg-card">
      {labels.map((label) => {
        const tone = stateTone(label.state)
        return (
          <li key={label.id}>
            <button
              type="button"
              onClick={() => onOpen(label)}
              className={cn(
                "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted focus-visible:outline-2",
                tone === "critical" && "bg-destructive/10",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "h-10 w-1.5 shrink-0 rounded-full bg-border",
                  tone === "critical" && "bg-destructive",
                  tone === "warning" && "bg-warning",
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{label.item_name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {KIND_LABEL[label.kind]} {formatFechaCorta(label.business_date)} · {label.employee_name}
                  {label.lot_code ? ` · lote ${label.lot_code}` : ""}
                  {label.qty_text ? ` · ${label.qty_text}` : ""}
                </span>
              </span>
              <span className="text-right">
                <span className={cn("block text-sm font-bold", tone === "critical" && "text-destructive")}>
                  {stateText(label)}
                </span>
                <span className="block font-mono text-xs text-muted-foreground">{codeText(label.code)}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

interface Candidate {
  key: string
  title: string
  detail: string
  badge: string | null
  preview: string | null
  previewSource: UseBySource | null
  /** Sin regla: la fecha la pone quien imprime. */
  needsDate: boolean
  qtyHint: string
  body: Omit<LabelCreateIn, "copies" | "qty_text" | "use_by" | "note">
}

function SourcesTab({
  kind,
  size,
  initialBatch = null,
}: {
  kind: "abri" | "recibi" | "produje"
  size: LabelSize
  initialBatch?: number | null
}) {
  const [search, setSearch] = useState("")
  const [selectedKey, setSelectedKey] = useState<string | null>(initialBatch ? `p${initialBatch}` : null)
  const searchId = useId()
  const sourcesQuery = useQuery({ queryKey: ["device", "labels", "sources"], queryFn: getLabelSources, refetchInterval: 30_000 })

  const candidates = useMemo<Candidate[]>(() => {
    const data = sourcesQuery.data
    if (!data) return []
    if (kind === "abri") {
      return data.openable.map((i) => ({
        key: `i${i.ingredient_id}`,
        title: i.name,
        detail: [
          i.opened_shelf_life_days ? `Dura ${i.opened_shelf_life_days} día(s) abierto` : "Sin días de abierto",
          i.next_batch?.lot_code ? `lote ${i.next_batch.lot_code}` : null,
          i.next_batch?.expires_at ? `vence ${formatFechaCorta(i.next_batch.expires_at)}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
        badge: i.category,
        preview: i.use_by_preview,
        previewSource: i.use_by_source_preview,
        needsDate: i.use_by_preview === null,
        qtyHint: "Ej. 1 kg, media bolsa",
        body: { kind: "opened", ingredient_id: i.ingredient_id, stock_batch_id: i.next_batch?.stock_batch_id ?? null },
      }))
    }
    if (kind === "recibi") {
      return data.received.map((r) => ({
        key: r.reception_draft_line_id !== null ? `d${r.reception_draft_line_id}` : `r${r.stock_batch_id}`,
        title: r.name,
        detail: [
          `Llegó ${formatFechaCorta(r.received_at)} ${formatClockTime(r.received_at)}`,
          `${r.qty_received} ${r.unit}`,
          r.lot_code ? `lote ${r.lot_code}` : "sin lote",
          r.pending ? "falta que el administrador la complete" : null,
        ]
          .filter(Boolean)
          .join(" · "),
        badge: r.labels_printed > 0 ? `${r.labels_printed} impresa(s)` : null,
        preview: r.expires_at,
        previewSource: r.expires_at ? "supplier" : null,
        needsDate: false,
        qtyHint: "Ej. 1 caja, 2 kg",
        body:
          r.reception_draft_line_id !== null
            ? { kind: "received", reception_draft_line_id: r.reception_draft_line_id }
            : { kind: "received", stock_batch_id: r.stock_batch_id },
      }))
    }
    return data.produced.map((p) => ({
      key: `p${p.prep_batch_id}`,
      title: p.name,
      detail: [
        `Producido ${formatFechaCorta(p.produced_at)} ${formatClockTime(p.produced_at)}`,
        `${p.qty_real} ${p.unit}`,
        p.produced_by,
      ].join(" · "),
      badge: p.labels_printed > 0 ? `${p.labels_printed} impresa(s)` : null,
      preview: p.expiry_date,
      previewSource: p.expiry_date ? "prep_shelf_life" : null,
      needsDate: p.expiry_date === null,
      qtyHint: "Ej. 500 ml, 1 tarro",
      body: { kind: "produced", prep_batch_id: p.prep_batch_id },
    }))
  }, [kind, sourcesQuery.data])

  const filtered = useMemo(() => {
    const q = fold(search)
    return q ? candidates.filter((c) => fold(c.title).includes(q)) : candidates
  }, [candidates, search])

  const selected = candidates.find((c) => c.key === selectedKey) ?? null

  if (sourcesQuery.isLoading) return <Skeleton className="h-40 w-full" />
  if (sourcesQuery.error) {
    return <EmptyState reason="error" title="No se pudo cargar" description={errorMessage(sourcesQuery.error)} role="alert" />
  }

  if (selected) {
    return <PrintForm key={selected.key} candidate={selected} size={size} onBack={() => setSelectedKey(null)} />
  }

  const empty =
    kind === "abri"
      ? "No hay insumos activos en esta sede."
      : kind === "recibi"
        ? "No se recibió mercancía en los últimos tres días."
        : "No hay producciones de los últimos tres días."

  return (
    <div className="space-y-3">
      {kind === "abri" ? (
        <div>
          <Label htmlFor={searchId} className="sr-only">
            Buscar insumo
          </Label>
          <Input
            id={searchId}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar insumo (ej. queso, crema)"
            className="h-12 text-base"
          />
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <EmptyState title="Nada para etiquetar" description={search ? "Ningún insumo coincide con la búsqueda." : empty} />
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {filtered.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => setSelectedKey(c.key)}
                className="flex min-h-16 w-full flex-col items-start rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted focus-visible:outline-2"
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="truncate font-bold">{c.title}</span>
                  {c.badge ? <span className="shrink-0 text-xs text-muted-foreground">{c.badge}</span> : null}
                </span>
                <span className="text-xs text-muted-foreground">{c.detail}</span>
                <span className="text-xs font-semibold">
                  {c.preview ? `Usar antes de ${formatFechaCorta(c.preview)}` : c.needsDate ? "Hay que poner la fecha" : "Sin vencimiento"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PrintForm({ candidate, size, onBack }: { candidate: Candidate; size: LabelSize; onBack: () => void }) {
  const queryClient = useQueryClient()
  const [copies, setCopies] = useState(1)
  const [qtyText, setQtyText] = useState("")
  const [useBy, setUseBy] = useState("")
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())
  const qtyId = useId()
  const dateId = useId()

  const mutation = useMutation({
    mutationFn: () =>
      createLabels(
        { ...candidate.body, copies, qty_text: qtyText.trim() || null, use_by: useBy || null },
        keyRef.current,
      ),
    onSuccess: ({ labels }) => {
      keyRef.current = newIdempotencyKey()
      const printed = printLabels(labels, size)
      if (printed) toast.success(`${labels.length} etiqueta(s) de ${candidate.title} a la impresora`)
      else toast.warning("Quedaron guardadas, pero este navegador no pudo abrir la impresión. Reimprimilas desde «En la cocina».")
      void queryClient.invalidateQueries({ queryKey: ["device", "labels"] })
      onBack()
    },
    onError: (err) => {
      keyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })

  const blocked = candidate.needsDate && !useBy

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {candidate.body.kind === "opened" ? "Abrí" : candidate.body.kind === "received" ? "Recibí" : "Produje"}
        </p>
        <h2 className="text-xl font-bold">{candidate.title}</h2>
        <p className="text-sm text-muted-foreground">{candidate.detail}</p>
      </div>

      <div className="rounded-lg border p-3">
        <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Usar antes de</p>
        {candidate.preview ? (
          <>
            <p className="text-2xl font-bold">{formatFechaCorta(useBy || candidate.preview)}</p>
            {candidate.previewSource && !useBy ? (
              <p className="text-xs text-muted-foreground">Sale de: {SOURCE_TEXT[candidate.previewSource]}</p>
            ) : null}
          </>
        ) : candidate.needsDate ? (
          <p className="text-sm font-semibold">
            Este producto no tiene regla: elegí la fecha. Para no elegirla cada vez, el administrador pone cuántos días dura
            en Inventario.
          </p>
        ) : (
          <p className="text-2xl font-bold">{useBy ? formatFechaCorta(useBy) : "Sin vencimiento"}</p>
        )}
        <div className="mt-2">
          <Label htmlFor={dateId}>{candidate.needsDate ? "Fecha «usar antes de»" : "¿Tiene que ser antes? (opcional)"}</Label>
          <Input
            id={dateId}
            type="date"
            value={useBy}
            max={candidate.preview ?? undefined}
            onChange={(e) => setUseBy(e.target.value)}
            className="h-12 w-auto"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor={qtyId}>Contenido (opcional)</Label>
          <Input
            id={qtyId}
            value={qtyText}
            maxLength={40}
            onChange={(e) => setQtyText(e.target.value)}
            placeholder={candidate.qtyHint}
            className="h-12"
          />
        </div>
        <div>
          <p className="mb-1.5 text-sm font-medium" id={`${qtyId}-copies`}>
            ¿Cuántos recipientes?
          </p>
          <div className="flex items-center gap-2" role="group" aria-labelledby={`${qtyId}-copies`}>
            <Button
              type="button"
              variant="outline"
              className="size-12"
              aria-label="Una menos"
              disabled={copies <= 1}
              onClick={() => setCopies((c) => Math.max(1, c - 1))}
            >
              <Minus className="size-5" aria-hidden />
            </Button>
            <span className="w-10 text-center text-2xl font-bold" aria-live="polite">
              {copies}
            </span>
            <Button
              type="button"
              variant="outline"
              className="size-12"
              aria-label="Una más"
              disabled={copies >= MAX_COPIES}
              onClick={() => setCopies((c) => Math.min(MAX_COPIES, c + 1))}
            >
              <Plus className="size-5" aria-hidden />
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button className="h-12 flex-1" disabled={blocked || mutation.isPending} onClick={() => mutation.mutate()}>
          <Printer className="size-5" aria-hidden />
          {copies === 1 ? "Imprimir etiqueta" : `Imprimir ${copies} etiquetas`}
        </Button>
        <Button variant="outline" className="h-12" onClick={onBack}>
          Volver
        </Button>
      </div>
    </div>
  )
}
