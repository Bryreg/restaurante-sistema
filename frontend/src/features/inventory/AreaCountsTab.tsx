import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { toast } from "sonner"

import {
  areaCountsCsvUrl,
  createCountArea,
  getAreaCount,
  getAreaCountSettings,
  listAreaCounts,
  listAreaRecounts,
  listCountAreas,
  putAreaCountSettings,
  setCountAreaItems,
  setCountAreaMember,
  updateCountArea,
  type AreaCountLineOut,
  type AreaCountOut,
  type AreaCountSettingsOut,
  type CountAreaOut,
} from "@/api/areaCounts"
import { listEmployees } from "@/api/employees"
import type { IngredientOut } from "@/api/inventory"
import {
  DenseTable,
  DenseTableBar,
  FormField,
  FormSection,
  MenuDeFila,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { CsvExportButton } from "@/components/CsvExportButton"
import { DateRangeFilter } from "@/components/DateRangeFilter"
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatPct } from "@/lib/format"
import { formatCOP } from "@/lib/money"

import { AREA_COUNTS_QUERY_KEYS, MOMENT_LABEL, WINDOW_LABEL, qtyText, shortageWord, withoutSign } from "./areaCountLib"
import { daysAgoLocal, todayLocal } from "./lib"
import { RecountDialog } from "./RecountDialog"

const MAX_ITEMS = 15
const SIN_AREA = "none"

const LEGEND: readonly LegendEntry[] = [
  {
    term: "De la noche",
    meaning: "la apertura contra el último cierre del área: lo que faltó mientras el local estaba cerrado.",
  },
  {
    term: "Del turno",
    meaning:
      "el cierre contra la apertura del mismo día, sumando lo que entró (recepciones, traslados, producción) y restando lo que el sistema registró que salió (ventas por receta, merma, consumo interno, traslados).",
  },
  {
    term: "Sin valor",
    meaning: (
      <>
        el insumo no tiene costo: la diferencia se ve en cantidad, <b>no es $ 0</b>.
      </>
    ),
  },
]

function windowText(c: AreaCountOut): string {
  if (c.moment === "spot") return "Recuento sorpresa"
  return `${MOMENT_LABEL[c.moment]} · ${WINDOW_LABEL[c.window]}`
}

// ---------------------------------------------------------------------------
// El detalle de un conteo: cada renglón con su derivación.
// ---------------------------------------------------------------------------

function DetailDialog({
  storeId,
  countId,
  onClose,
}: {
  storeId: number
  countId: number | null
  onClose: () => void
}): React.JSX.Element {
  const query = useQuery({
    queryKey: AREA_COUNTS_QUERY_KEYS.count(storeId, countId ?? 0),
    queryFn: () => getAreaCount(storeId, countId as number),
    enabled: countId !== null,
  })
  const detail = query.data
  const columns: readonly DenseColumn<AreaCountLineOut>[] = [
    { key: "name", header: "Artículo", kind: "name", cell: (l) => l.ingredient_name },
    {
      key: "counted",
      header: "Contado",
      kind: "number",
      cell: (l) => qtyText(l.counted_qty, l.base_unit),
      cellTitle: (l) => `Tecleado: ${l.entered_qty} ${l.entered_unit}`,
    },
    {
      key: "expected",
      header: detail?.moment === "spot" ? "Sistema" : "Esperado",
      kind: "number",
      cell: (l) => (l.expected_qty === null ? <span className="text-muted-foreground">—</span> : qtyText(l.expected_qty, l.base_unit)),
      cellTitle: (l) => l.null_reason ?? undefined,
    },
    {
      key: "shortage",
      header: "Diferencia",
      kind: "number",
      cell: (l) => {
        const word = shortageWord(l.shortage_qty)
        if (l.shortage_qty === null) return <span className="text-muted-foreground">sin dato</span>
        if (word === null) return "Cuadra"
        return (
          <span className={l.flagged ? "font-bold text-destructive" : undefined}>
            {word} {qtyText(withoutSign(l.shortage_qty), l.base_unit)}
          </span>
        )
      },
    },
    {
      key: "value",
      header: "Valor",
      kind: "number",
      cell: (l) =>
        l.shortage_value === null ? (
          <span className="text-muted-foreground">{l.shortage_qty === null ? "—" : "sin valor"}</span>
        ) : (
          formatCOP(l.shortage_value)
        ),
    },
    { key: "ref", header: "Antes", kind: "number", secondary: true, cell: (l) => qtyText(l.reference_qty, l.base_unit) },
    { key: "in", header: "Entradas", kind: "number", secondary: true, cell: (l) => qtyText(l.inflow_qty, l.base_unit) },
    { key: "out", header: "Salidas", kind: "number", secondary: true, cell: (l) => qtyText(l.outflow_qty, l.base_unit) },
    { key: "pct", header: "% de lo esperado", kind: "number", secondary: true, cell: (l) => formatPct(l.shortage_pct_bp) },
  ]

  return (
    <Dialog open={countId !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail ? `${detail.area_name} · ${windowText(detail)}` : "Conteo"}</DialogTitle>
          <DialogDescription>
            {detail
              ? `Contó ${detail.employee_name} · ${formatInstant(detail.counted_at)}` +
                (detail.reference_employee_name
                  ? ` · contra lo que contó ${detail.reference_employee_name} · ${formatInstant(detail.reference_counted_at)}`
                  : "")
              : "Leyendo…"}
          </DialogDescription>
        </DialogHeader>
        {query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(query.error)}
          </p>
        ) : null}
        {detail?.reason ? <p className="text-sm text-muted-foreground">{detail.reason}</p> : null}
        {detail?.superseded ? (
          <p className="text-sm text-muted-foreground">Se volvió a contar después: manda el último conteo.</p>
        ) : null}
        {detail ? (
          <DenseTable
            caption="Renglones del conteo"
            columns={columns}
            rows={detail.lines}
            rowKey={(l) => String(l.ingredient_id)}
            rowStatus={(l) => (l.flagged ? "critical" : "none")}
            note={
              detail.moment === "spot" ? (
                <>La diferencia es contra el stock del sistema en el instante del recuento.</>
              ) : (
                <>
                  Esperado = lo contado antes + entradas − salidas registradas. La diferencia la calcula el servidor;
                  «faltan» es que se contó menos de lo esperado.
                </>
              )
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Historial.
// ---------------------------------------------------------------------------

function HistorySection({
  storeId,
  areas,
  initialCountId,
}: {
  storeId: number
  areas: CountAreaOut[]
  initialCountId: number | null
}): React.JSX.Element {
  const [from, setFrom] = useState(daysAgoLocal(14))
  const [to, setTo] = useState(todayLocal())
  const [areaId, setAreaId] = useState<number | null>(null)
  const [detailId, setDetailId] = useState<number | null>(initialCountId)
  const query = useQuery({
    queryKey: AREA_COUNTS_QUERY_KEYS.counts(storeId, from, to, areaId),
    queryFn: () => listAreaCounts({ storeId, from, to, areaId }),
  })
  const rows = query.data ?? []
  const flagged = rows.filter((r) => r.flagged_count > 0 && !r.superseded).length

  function status(c: AreaCountOut): RowStatus {
    if (c.superseded) return "none"
    return c.flagged_count > 0 ? "critical" : "ok"
  }

  const columns: readonly DenseColumn<AreaCountOut>[] = [
    {
      key: "area",
      header: "Área",
      kind: "name",
      cell: (c) => (
        <button
          type="button"
          className="text-primary underline underline-offset-2"
          onClick={() => setDetailId(c.id)}
          aria-label={`Ver el detalle del conteo de ${c.area_name}`}
        >
          {c.area_name}
        </button>
      ),
    },
    { key: "kind", header: "Conteo", cell: windowText },
    {
      key: "who",
      header: "Quién",
      cell: (c) => (
        <span>
          {c.employee_name} · <TimeAgo iso={c.counted_at} />
        </span>
      ),
    },
    {
      key: "flagged",
      header: "Fuera del umbral",
      kind: "number",
      cell: (c) =>
        c.reason ? (
          <span className="text-muted-foreground" title={c.reason}>
            sin comparar
          </span>
        ) : (
          `${c.flagged_count} de ${c.lines_count}`
        ),
    },
    {
      key: "value",
      header: "Faltante",
      kind: "number",
      cell: (c) =>
        c.shortage_value_total === null ? <span className="text-muted-foreground">—</span> : formatCOP(c.shortage_value_total),
      cellTitle: (c) => (c.unvalued_lines > 0 ? `${c.unvalued_lines} artículo(s) sin costo, fuera de la suma` : undefined),
    },
    {
      key: "date",
      header: "Día operativo",
      secondary: true,
      cell: (c) => c.business_date,
    },
    {
      key: "superseded",
      header: "Vigente",
      secondary: true,
      cell: (c) => (c.superseded ? "No: se volvió a contar" : "Sí"),
    },
  ]

  return (
    <section aria-labelledby="area-counts-history" className="space-y-2">
      <h3 id="area-counts-history" className="text-base font-bold">
        Conteos cortos
      </h3>
      <DenseTable
        caption="Conteos cortos por área"
        columns={columns}
        rows={rows}
        rowKey={(c) => String(c.id)}
        rowStatus={status}
        rowInactive={(c) => c.superseded}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={rows.length}
            total={rows.length}
            noun="conteos en el período"
            hidden={query.isLoading ? "contando…" : flagged > 0 ? `${flagged} con artículos fuera del umbral` : undefined}
          >
            <DateRangeFilter
              idPrefix="area-counts"
              from={from}
              to={to}
              onChange={(r) => {
                setFrom(r.from)
                setTo(r.to)
              }}
            />
            <div className="flex items-center gap-2">
              <Label htmlFor="area-counts-area">Área</Label>
              <Select
                value={areaId === null ? "all" : String(areaId)}
                onValueChange={(v) => setAreaId(v === "all" ? null : Number(v))}
              >
                <SelectTrigger id="area-counts-area" className="h-8 w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  {areas.map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <CsvExportButton href={areaCountsCsvUrl({ storeId, from, to, areaId })} />
          </DenseTableBar>
        }
        note={
          <>
            Contar es <b>a ciegas</b> y <b>no mueve el stock</b>: sólo mide contra lo que el sistema esperaba. Si
            un área no cuenta, no se bloquea abrir ni cerrar el turno; se avisa en Hoy.
          </>
        }
        empty={
          query.isError ? (
            <EmptyState
              reason="error"
              role="alert"
              title="No se pudieron leer los conteos"
              description={errorMessage(query.error)}
              action={{ label: "Reintentar", onClick: () => void query.refetch() }}
            />
          ) : query.isLoading ? undefined : (
            <EmptyState
              title="Sin conteos cortos en este período"
              description="Se cuentan desde el POS, en «Conteo de mi área» del turno. Ampliá el rango si el último quedó más atrás."
            />
          )
        }
      />
      <DetailDialog storeId={storeId} countId={detailId} onClose={() => setDetailId(null)} />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Recuentos sorpresa.
// ---------------------------------------------------------------------------

function RecountsSection({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: AREA_COUNTS_QUERY_KEYS.recounts(storeId),
    queryFn: () => listAreaRecounts(storeId),
  })
  const rows = (query.data ?? []).slice(0, 10)
  return (
    <section aria-labelledby="area-recounts" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="area-recounts" className="text-base font-bold">
          Recuentos sorpresa
        </h3>
        <div className="ml-auto">
          <RecountDialog storeId={storeId} />
        </div>
      </div>
      {query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(query.error)}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Todavía no se pidió ninguno.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="font-bold">{r.area_name}</span>
              <span>{r.items.map((i) => i.name).join(", ")}</span>
              <span className="text-muted-foreground">
                pedido <TimeAgo iso={r.requested_at} />
              </span>
              <span className={r.status === "pending" ? "ml-auto text-warning-foreground" : "ml-auto text-muted-foreground"}>
                {r.status === "pending" ? "Pendiente en el POS" : "Respondido"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Configuración: áreas, artículos, quién es de qué área, umbral.
// ---------------------------------------------------------------------------

function ItemsDialog({
  storeId,
  area,
  areas,
  ingredients,
  onClose,
}: {
  storeId: number
  area: CountAreaOut | null
  areas: CountAreaOut[]
  ingredients: IngredientOut[]
  onClose: () => void
}): React.JSX.Element {
  // Se monta de nuevo por área (`key`): el estado arranca de la lista guardada.
  const [chosen, setChosen] = useState<number[]>(() => (area ? area.items.map((i) => i.ingredient_id) : []))
  const queryClient = useQueryClient()
  const inOther = new Map<number, string>()
  for (const a of areas) {
    if (!a.active || a.id === area?.id) continue
    for (const i of a.items) inOther.set(i.ingredient_id, a.name)
  }
  const mutation = useMutation({
    mutationFn: () => setCountAreaItems(storeId, area?.id as number, chosen),
    onSuccess: () => {
      toast.success("Lista guardada.")
      void queryClient.invalidateQueries({ queryKey: ["area-counts"] })
      onClose()
    },
  })
  return (
    <Dialog open={area !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Artículos que cuenta {area?.name}</DialogTitle>
          <DialogDescription>
            Los clave, no todo el inventario: de 5 a {MAX_ITEMS}. Un insumo se cuenta en una sola área.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm">
          <b className="tabular-nums">{chosen.length}</b> de {MAX_ITEMS} como máximo
        </p>
        <ul className="space-y-1.5">
          {ingredients.map((ing) => {
            const checked = chosen.includes(ing.id)
            const other = inOther.get(ing.id)
            const id = `area-item-${ing.id}`
            return (
              <li key={ing.id} className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={checked}
                  disabled={other !== undefined || (!checked && chosen.length >= MAX_ITEMS)}
                  onCheckedChange={(v) =>
                    setChosen((prev) => (v === true ? [...prev, ing.id] : prev.filter((x) => x !== ing.id)))
                  }
                />
                <Label htmlFor={id} className="font-normal">
                  {ing.name}
                  {other ? <span className="text-xs text-muted-foreground"> · se cuenta en {other}</span> : null}
                </Label>
              </li>
            )
          })}
        </ul>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            Guardar lista
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RenameDialog({
  storeId,
  area,
  onClose,
}: {
  storeId: number
  area: CountAreaOut | null
  onClose: () => void
}): React.JSX.Element {
  const [name, setName] = useState(() => area?.name ?? "")
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => updateCountArea(storeId, area?.id as number, { name: name.trim() }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["area-counts"] })
      onClose()
    },
  })
  return (
    <Dialog open={area !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Renombrar área</DialogTitle>
          <DialogDescription>Los conteos ya hechos conservan el nombre con que se hicieron.</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="area-rename">Nombre</Label>
          <Input id="area-rename" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" disabled={name.trim() === "" || mutation.isPending} onClick={() => mutation.mutate()}>
            Guardar nombre
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AreasSection({
  storeId,
  areas,
  ingredients,
  loading,
}: {
  storeId: number
  areas: CountAreaOut[]
  ingredients: IngredientOut[]
  loading: boolean
}): React.JSX.Element {
  const [newName, setNewName] = useState("")
  const [editingItems, setEditingItems] = useState<CountAreaOut | null>(null)
  const [renaming, setRenaming] = useState<CountAreaOut | null>(null)
  const queryClient = useQueryClient()
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["area-counts"] })
  const create = useMutation({
    mutationFn: () => createCountArea(storeId, newName.trim()),
    onSuccess: () => {
      setNewName("")
      refresh()
    },
  })
  const toggle = useMutation({
    mutationFn: (a: CountAreaOut) => updateCountArea(storeId, a.id, { active: !a.active }),
    onSuccess: refresh,
  })

  const columns: readonly DenseColumn<CountAreaOut>[] = [
    { key: "name", header: "Área", kind: "name", cell: (a) => a.name },
    {
      key: "items",
      header: "Artículos",
      cell: (a) => (a.items.length === 0 ? <span className="text-warning-foreground">sin lista</span> : `${a.items.length}`),
      cellTitle: (a) => a.items.map((i) => i.name).join(", ") || undefined,
    },
    {
      key: "people",
      header: "Personas",
      cell: (a) => (a.members.length === 0 ? <span className="text-muted-foreground">nadie</span> : a.members.map((m) => m.employee_name).join(", ")),
    },
    { key: "state", header: "Estado", kind: "secondary", cell: (a) => (a.active ? "Activa" : "Desactivada") },
    {
      key: "actions",
      header: "",
      kind: "actions",
      cell: (a) => (
        <MenuDeFila nombre={a.name}>
          <DropdownMenuItem onClick={() => setEditingItems(a)}>Artículos</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setRenaming(a)}>Renombrar</DropdownMenuItem>
          <DropdownMenuItem onClick={() => toggle.mutate(a)}>{a.active ? "Desactivar" : "Activar"}</DropdownMenuItem>
        </MenuDeFila>
      ),
    },
  ]

  return (
    <section aria-labelledby="count-areas" className="space-y-2">
      <h3 id="count-areas" className="text-base font-bold">
        Áreas y sus artículos clave
      </h3>
      <DenseTable
        caption="Áreas de conteo"
        columns={columns}
        rows={areas}
        rowKey={(a) => String(a.id)}
        rowStatus={(a) => (a.active && a.items.length === 0 ? "warning" : "none")}
        rowInactive={(a) => !a.active}
        bar={
          <DenseTableBar shown={areas.filter((a) => a.active).length} total={areas.length} noun="áreas activas">
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                if (newName.trim() !== "") create.mutate()
              }}
            >
              <Label htmlFor="new-area" className="sr-only">
                Nombre del área nueva
              </Label>
              <Input
                id="new-area"
                className="h-8 w-40"
                placeholder="Bar, Cocina…"
                maxLength={80}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <Button type="submit" size="sm" disabled={newName.trim() === "" || create.isPending}>
                Nueva área
              </Button>
            </form>
          </DenseTableBar>
        }
        note={
          create.isError || toggle.isError ? (
            <span role="alert" className="text-destructive">
              {errorMessage(create.error ?? toggle.error)}
            </span>
          ) : (
            <>Desactivar un área no borra sus conteos: deja de aparecer en el POS.</>
          )
        }
        empty={
          loading ? undefined : (
            <EmptyState
              title="Todavía no hay áreas de conteo"
              description="Creá una por cada lugar que responde por lo suyo: Bar, Cocina."
            />
          )
        }
      />
      <ItemsDialog
        key={`items-${editingItems?.id ?? "none"}`}
        storeId={storeId}
        area={editingItems}
        areas={areas}
        ingredients={ingredients}
        onClose={() => setEditingItems(null)}
      />
      <RenameDialog
        key={`rename-${renaming?.id ?? "none"}`}
        storeId={storeId}
        area={renaming}
        onClose={() => setRenaming(null)}
      />
    </section>
  )
}

interface MemberRow {
  id: number
  name: string
  areaId: number | null
}

function MembersSection({ storeId, areas }: { storeId: number; areas: CountAreaOut[] }): React.JSX.Element {
  const queryClient = useQueryClient()
  const employeesQuery = useQuery({
    queryKey: ["employees", storeId, "active"],
    queryFn: () => listEmployees({ storeId, active: true }),
  })
  const assign = useMutation({
    mutationFn: (v: { employeeId: number; areaId: number | null }) => setCountAreaMember(storeId, v.employeeId, v.areaId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["area-counts"] }),
  })
  const areaOf = new Map<number, number>()
  for (const a of areas) for (const m of a.members) areaOf.set(m.employee_id, a.id)
  const rows: MemberRow[] = (employeesQuery.data ?? [])
    .filter((e) => e.store_id === storeId || e.store_id === null)
    .map((e) => ({ id: e.id, name: e.name, areaId: areaOf.get(e.id) ?? null }))
  const activeAreas = areas.filter((a) => a.active)
  const sinArea = rows.filter((r) => r.areaId === null).length

  const columns: readonly DenseColumn<MemberRow>[] = [
    { key: "name", header: "Persona", kind: "name", cell: (r) => r.name },
    {
      key: "area",
      header: "Área de conteo",
      cell: (r) => (
        <Select
          value={r.areaId === null ? SIN_AREA : String(r.areaId)}
          onValueChange={(v) => assign.mutate({ employeeId: r.id, areaId: v === SIN_AREA ? null : Number(v) })}
        >
          <SelectTrigger className="h-7 w-40" aria-label={`Área de conteo de ${r.name}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={SIN_AREA}>Sin área</SelectItem>
            {activeAreas.map((a) => (
              <SelectItem key={a.id} value={String(a.id)}>
                {a.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
  ]

  return (
    <section aria-labelledby="count-members" className="space-y-2">
      <h3 id="count-members" className="text-base font-bold">
        Quién es de qué área
      </h3>
      <DenseTable
        caption="Personas y su área de conteo"
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.id)}
        bar={
          <DenseTableBar
            shown={rows.length - sinArea}
            total={rows.length}
            noun="personas con área"
            hidden={sinArea > 0 ? `${sinArea} sin área: no ven lista en el POS` : undefined}
          />
        }
        note={
          assign.isError ? (
            <span role="alert" className="text-destructive">
              {errorMessage(assign.error)}
            </span>
          ) : (
            <>Cada persona tiene una sola área. En el POS ve sólo la lista de la suya.</>
          )
        }
      />
    </section>
  )
}

/** «2» o «2,5» → puntos básicos. Es leer lo que se tecleó, no una cuenta de negocio. */
function percentTextToBp(text: string): number | null {
  const trimmed = text.trim().replace(",", ".")
  if (trimmed === "") return null
  const value = Number(trimmed)
  if (Number.isNaN(value) || value <= 0 || value > 100) return null
  return Math.round(value * 100)
}

function bpToPercentText(bp: number | null): string {
  return bp === null ? "" : String(bp / 100).replace(".", ",")
}

function ThresholdSection({ storeId }: { storeId: number }): React.JSX.Element {
  const query = useQuery({
    queryKey: AREA_COUNTS_QUERY_KEYS.settings(storeId),
    queryFn: () => getAreaCountSettings(storeId),
  })
  const data = query.data
  // Se monta de nuevo cuando llega (o cambia) lo guardado: los campos arrancan de ahí.
  return (
    <ThresholdForm
      key={data ? `${data.threshold_pct_bp}-${data.threshold_amount}` : "leyendo"}
      storeId={storeId}
      settings={data}
    />
  )
}

function ThresholdForm({
  storeId,
  settings,
}: {
  storeId: number
  settings: AreaCountSettingsOut | undefined
}): React.JSX.Element {
  const queryClient = useQueryClient()
  const [pctText, setPctText] = useState(() => bpToPercentText(settings?.threshold_pct_bp ?? null))
  const [amount, setAmount] = useState<number | null>(() => settings?.threshold_amount ?? null)
  const pctBp = percentTextToBp(pctText)
  const pctInvalid = pctText.trim() !== "" && pctBp === null
  const mutation = useMutation({
    mutationFn: () => putAreaCountSettings(storeId, { threshold_pct_bp: pctBp, threshold_amount: amount }),
    onSuccess: (data) => {
      toast.success("Umbral guardado.")
      queryClient.setQueryData(AREA_COUNTS_QUERY_KEYS.settings(storeId), data)
      void queryClient.invalidateQueries({ queryKey: ["area-counts", "counts"] })
    },
  })
  const dirty =
    settings !== undefined && (pctBp !== settings.threshold_pct_bp || amount !== settings.threshold_amount)

  return (
    <FormSection
      title="Umbral de aviso"
      governs="Cuándo una diferencia de un conteo corto se marca en Hoy y en el historial."
      reading={settings ? settings.reading : "Leyendo el umbral…"}
      doesNotDo="Nunca bloquea abrir ni cerrar el turno, ni mueve el stock: sólo decide qué se avisa."
    >
      <FormField
        label="Porcentaje de lo esperado"
        help="Vacío = no se exige porcentaje."
        error={pctInvalid ? "Escribí un porcentaje entre 0 y 100, por ejemplo 2 o 2,5." : undefined}
      >
        {({ fieldId, describedBy }) => (
          <div className="flex items-center gap-2">
            <Input
              id={fieldId}
              aria-describedby={describedBy}
              inputMode="decimal"
              className="w-24"
              value={pctText}
              onChange={(e) => setPctText(e.target.value)}
            />
            <span className="text-sm text-muted-foreground">%</span>
          </div>
        )}
      </FormField>
      <FormField label="Monto" help="Vacío = no se exige monto. Sin costo conocido, manda sólo el porcentaje.">
        {({ fieldId, describedBy }) => (
          <MoneyInput id={fieldId} aria-describedby={describedBy} value={amount} onChange={setAmount} />
        )}
      </FormField>
      <div className="flex items-end">
        <Button type="button" disabled={!dirty || pctInvalid || mutation.isPending} onClick={() => mutation.mutate()}>
          Guardar umbral
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
    </FormSection>
  )
}

/**
 * Admin → Inventario › Conteo por área (`inventory.shift_counts`). Arriba lo
 * que se mira todos los días —los conteos cortos con sus diferencias y los
 * recuentos sorpresa—; debajo, la configuración: áreas y sus artículos
 * clave, quién es de qué área y el umbral de aviso. Toda cifra viene del
 * servidor (esperado, diferencia, valor): la pantalla no suma ni resta.
 *
 * `initialCountId` abre el detalle de un conteo al llegar desde un aviso de
 * Hoy (`?tab=por-area&conteo=ID`).
 */
export function AreaCountsTab({
  storeId,
  ingredients,
  initialCountId = null,
}: {
  storeId: number
  ingredients: IngredientOut[]
  initialCountId?: number | null
}): React.JSX.Element {
  const areasQuery = useQuery({
    queryKey: AREA_COUNTS_QUERY_KEYS.areas(storeId),
    queryFn: () => listCountAreas(storeId),
  })
  const areas = areasQuery.data ?? []
  if (areasQuery.isError) {
    return (
      <EmptyState
        reason="error"
        role="alert"
        title="No se pudo leer el conteo por área"
        description={errorMessage(areasQuery.error)}
        action={{ label: "Reintentar", onClick: () => void areasQuery.refetch() }}
      />
    )
  }
  return (
    <div className="space-y-8">
      <HistorySection storeId={storeId} areas={areas} initialCountId={initialCountId} />
      <RecountsSection storeId={storeId} />
      <AreasSection storeId={storeId} areas={areas} ingredients={ingredients} loading={areasQuery.isLoading} />
      <MembersSection storeId={storeId} areas={areas} />
      <ThresholdSection storeId={storeId} />
    </div>
  )
}

export default AreaCountsTab
