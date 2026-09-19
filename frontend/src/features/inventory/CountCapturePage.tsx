import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"
import { Link, useParams } from "react-router-dom"
import { toast } from "sonner"

import { useStoreSelection } from "@/app/storeContext"
import { ApiError, newIdempotencyKey } from "@/api/client"
import {
  getCount,
  postApplyCount,
  putCountLines,
  type CountApplyOut,
  type CountLineOut,
  type CountLineRefIn,
  type CountDetailOut,
} from "@/api/inventory"
import { EmptyState } from "@/components/EmptyState"
import { PinPad } from "@/components/PinPad"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { parseCountInput } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

function queryKeyFor(storeId: number | null, countId: number) {
  return ["inventory", "count", storeId, countId] as const
}

/**
 * Captura a ciegas de un conteo (`/admin/inventario/conteos/:countId`,
 * SPEC-NEGOCIO §5.4). **Contrato duro de esta pantalla, no negociable**:
 *
 * - **A CIEGAS de verdad**: este archivo no importa `getInventoryStock` ni
 *   ninguna otra función que traiga stock teórico, por ningún camino. La
 *   ÚNICA referencia en pantalla es `CountLineOut.previous_qty_counted`
 *   (el conteo anterior) — y el tipo mismo (`api/inventory.ts`) no tiene
 *   dónde guardar un stock teórico aunque alguien quisiera.
 * - **No existe "todo coincide"**: no hay checkbox de encabezado, no hay
 *   botón "confirmar todos" ni "marcar todos". `was_counted` se confirma
 *   RENGLÓN POR RENGLÓN con el botón "Confirmar" de esa fila — es la única
 *   acción que manda `was_counted: true`, y siempre para un solo insumo.
 * - **Un borrador local nunca pisa un valor confirmado**: lo que la persona
 *   tipea vive en `drafts` (estado local, por `ingredient_id`) hasta que se
 *   guarda. "Guardar avance" manda TODOS los renglones tocados con
 *   `was_counted: false` — el servidor ignora en silencio los que ya
 *   estaban confirmados (`was_counted: true`) en vez de pisarlos, y esta
 *   pantalla reemplaza el estado local por la respuesta fresca del
 *   servidor después de cada guardado: si el servidor ignoró el borrador,
 *   la pantalla vuelve a mostrar el valor confirmado, no lo que se tipeó.
 * - **Un guardado parcial lo dice**: el banner de abajo usa
 *   `lines_counted`/`lines_total` tal como los manda el servidor, siempre
 *   visible mientras falte algún renglón — no sólo justo después de guardar.
 */
export function CountCapturePage(): React.JSX.Element {
  const params = useParams<{ countId: string }>()
  const countId = Number(params.countId)
  const { activeStoreId, loading: storeLoading } = useStoreSelection()
  const queryClient = useQueryClient()

  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [rowError, setRowError] = useState<Record<number, string>>({})
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyResult, setApplyResult] = useState<CountApplyOut | null>(null)
  const [alreadyApplied, setAlreadyApplied] = useState(false)
  const applyIdempotencyKeyRef = useRef(newIdempotencyKey())

  const query = useQuery({
    queryKey: queryKeyFor(activeStoreId, countId),
    queryFn: () => getCount(countId, activeStoreId as number),
    enabled: activeStoreId !== null && Number.isFinite(countId),
  })

  const saveMutation = useMutation({
    mutationFn: (lines: CountLineRefIn[]) => putCountLines(countId, activeStoreId as number, { lines }),
    onSuccess: (result, sentLines) => {
      queryClient.setQueryData<CountDetailOut | undefined>(queryKeyFor(activeStoreId, countId), (old) =>
        old ? { ...old, lines: result.lines, lines_total: result.lines_total, lines_counted: result.lines_counted } : old,
      )
      // El borrador local se descarta apenas se guarda — lo que se ve
      // después es SIEMPRE la respuesta del servidor, nunca lo que se
      // tipeó: si el servidor ignoró un renglón (ya estaba confirmado por
      // otra persona), acá deja de mostrarse el borrador y aparece el
      // valor confirmado.
      setDrafts((prev) => {
        const next = { ...prev }
        for (const line of sentLines) delete next[line.ingredient_id]
        return next
      })
      setRowError((prev) => {
        const next = { ...prev }
        for (const line of sentLines) delete next[line.ingredient_id]
        return next
      })
    },
  })

  const applyMutation = useMutation({
    mutationFn: (pin: string) => postApplyCount(countId, activeStoreId as number, pin, applyIdempotencyKeyRef.current),
    onSuccess: (result) => {
      setApplyResult(result)
      toast.success("Conteo aplicado.")
      void queryClient.invalidateQueries({ queryKey: queryKeyFor(activeStoreId, countId) })
      void queryClient.invalidateQueries({ queryKey: ["inventory", "counts", activeStoreId] })
    },
    onError: (err) => {
      // `409 COUNT_ALREADY_APPLIED`: se explica y NO se ofrece reintentar
      // (SPEC-NEGOCIO §5.4) — se saca el `PinPad` de la vista en vez de
      // dejarlo ahí invitando a un segundo intento que de todas formas
      // volvería a fallar igual.
      if (err instanceof ApiError && err.status === 409 && err.code === "COUNT_ALREADY_APPLIED") {
        setAlreadyApplied(true)
        return
      }
      if (!(err instanceof ApiError) || err.status !== 409) {
        applyIdempotencyKeyRef.current = newIdempotencyKey()
      }
    },
  })

  if (storeLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando sedes…</p>
  }
  if (activeStoreId === null) {
    return <p className="p-4 text-sm text-muted-foreground">Todavía no hay sedes creadas.</p>
  }
  if (query.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Cargando el conteo…</p>
  }
  if (query.isError) {
    return (
      <EmptyState
        role="alert"
        title="No se pudo cargar el conteo"
        description={errorMessage(query.error)}
        action={{ label: "Reintentar", onClick: () => void query.refetch() }}
      />
    )
  }
  const count = query.data
  if (!count) {
    return <EmptyState title="Sin datos" />
  }

  function draftFor(line: CountLineOut): string {
    return drafts[line.ingredient_id] ?? line.qty_counted ?? ""
  }

  function updateDraft(ingredientId: number, text: string): void {
    setDrafts((prev) => ({ ...prev, [ingredientId]: text }))
  }

  function confirmLine(line: CountLineOut): void {
    const text = draftFor(line)
    const parsed = parseCountInput(text)
    if (!parsed.valid || parsed.value === null) {
      setRowError((prev) => ({ ...prev, [line.ingredient_id]: "Cantidad inválida — revisá el valor." }))
      return
    }
    saveMutation.mutate([{ ingredient_id: line.ingredient_id, qty_counted: parsed.value, was_counted: true }])
  }

  function saveDraftProgress(): void {
    const lines: CountLineRefIn[] = []
    const nextErrors: Record<number, string> = {}
    for (const [idText, text] of Object.entries(drafts)) {
      const ingredientId = Number(idText)
      if (text.trim() === "") continue
      const parsed = parseCountInput(text)
      if (parsed.valid && parsed.value !== null) {
        lines.push({ ingredient_id: ingredientId, qty_counted: parsed.value, was_counted: false })
      } else {
        nextErrors[ingredientId] = "Cantidad inválida — revisá el valor."
      }
    }
    setRowError((prev) => ({ ...prev, ...nextErrors }))
    if (lines.length > 0) saveMutation.mutate(lines)
  }

  const isOpen = count.status === "open"
  const hasPartial = count.lines_counted < count.lines_total

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Conteo #{count.id}</h1>
          <p className="text-sm text-muted-foreground">
            {count.scope === "key_items" ? "Críticos" : "Completo"} — abierto por {count.opened_by_employee_name} el{" "}
            {formatInstant(count.opened_at)}
          </p>
        </div>
        <Link to="/admin/inventario?tab=conteos" className="text-sm text-primary underline underline-offset-2">
          Volver a conteos
        </Link>
      </div>

      <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        Conteo <strong>a ciegas</strong>: esta pantalla no muestra el stock del sistema. La única referencia es el{" "}
        <strong>conteo anterior</strong> de cada insumo, cuando existe.
      </div>

      {hasPartial ? (
        <div role="status" className="rounded-md border border-dashed p-3 text-sm">
          <strong>Guardado parcial:</strong> {count.lines_counted} de {count.lines_total} renglones confirmados.
        </div>
      ) : (
        <div role="status" className="rounded-md border p-3 text-sm text-muted-foreground">
          Todos los renglones ({count.lines_total}) están confirmados.
        </div>
      )}

      {count.status === "applied" ? (
        <div className="rounded-md border p-3 text-sm">
          Este conteo ya se aplicó — {formatInstant(count.applied_at)} por {count.applied_by_employee_name}. No se
          puede volver a capturar ni a aplicar.
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Insumo</TableHead>
              <TableHead>Conteo anterior</TableHead>
              <TableHead>Cantidad contada</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Acción</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {count.lines.map((line) => {
              const draft = draftFor(line)
              const parsed = parseCountInput(draft)
              const invalid = draft.trim() !== "" && !parsed.valid
              const error = rowError[line.ingredient_id]
              return (
                <TableRow key={line.ingredient_id}>
                  <TableCell className="font-medium">{line.ingredient_name}</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">
                    {line.previous_qty_counted !== null
                      ? `${line.previous_qty_counted} ${UNIT_LABEL[line.base_unit] ?? line.base_unit}`
                      : "Sin conteo anterior"}
                  </TableCell>
                  <TableCell>
                    <Input
                      inputMode="decimal"
                      className="h-10 w-40"
                      placeholder="p. ej. 6+8 ó 3,5"
                      value={draft}
                      disabled={!isOpen}
                      aria-invalid={invalid || Boolean(error)}
                      aria-label={`Cantidad contada — ${line.ingredient_name}`}
                      onChange={(event) => {
                        updateDraft(line.ingredient_id, event.target.value)
                        setRowError((prev) => {
                          if (!(line.ingredient_id in prev)) return prev
                          const next = { ...prev }
                          delete next[line.ingredient_id]
                          return next
                        })
                      }}
                    />
                    {invalid || error ? (
                      <p className="mt-1 text-xs text-destructive">{error ?? "Cantidad inválida — no se envía."}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={line.was_counted ? "secondary" : "outline"}>
                      {line.was_counted ? "Confirmado" : "Sin confirmar"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      disabled={!isOpen || draft.trim() === "" || !parsed.valid || saveMutation.isPending}
                      onClick={() => confirmLine(line)}
                    >
                      Confirmar
                    </Button>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      {isOpen ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" disabled={saveMutation.isPending} onClick={saveDraftProgress}>
            {saveMutation.isPending ? "Guardando…" : "Guardar avance (sin confirmar)"}
          </Button>
          {saveMutation.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage(saveMutation.error)}
            </p>
          ) : null}

          <Dialog
            open={applyOpen}
            onOpenChange={(next) => {
              setApplyOpen(next)
              if (!next) applyMutation.reset()
            }}
          >
            <DialogTrigger render={<Button type="button" variant="destructive" className="ml-auto" />}>
              Aplicar conteo
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Aplicar el conteo #{count.id}</DialogTitle>
                <DialogDescription>
                  Esta acción es <strong>irreversible</strong> y se hace <strong>una sola vez</strong>: ajusta el
                  stock a «contado + (entradas − salidas desde el instante del conteo)». Necesita el PIN de un
                  administrador.
                </DialogDescription>
              </DialogHeader>
              {alreadyApplied ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm font-medium text-destructive">
                    Este conteo ya se aplicó — no se puede aplicar dos veces. No hay nada para reintentar.
                  </p>
                  <Button type="button" variant="outline" onClick={() => setApplyOpen(false)}>
                    Cerrar
                  </Button>
                </div>
              ) : (
                <>
                  {applyMutation.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                      {errorMessage(applyMutation.error)}
                    </p>
                  ) : null}
                  <PinPad
                    length={4}
                    label="PIN de administrador para aplicar el conteo"
                    disabled={applyMutation.isPending}
                    onSubmit={(pin) => applyMutation.mutate(pin)}
                  />
                </>
              )}
            </DialogContent>
          </Dialog>
        </div>
      ) : null}

      {applyResult ? (
        <section className="space-y-3 border-t pt-4">
          <h2 className="text-sm font-semibold">Ajuste aplicado</h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Insumo</TableHead>
                  <TableHead>Contado</TableHead>
                  <TableHead>Stock antes</TableHead>
                  <TableHead>Ajuste</TableHead>
                  <TableHead>Stock después</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {applyResult.lines.map((line) => (
                  <TableRow key={line.ingredient_id}>
                    <TableCell className="font-medium">{line.ingredient_name}</TableCell>
                    <TableCell className="tabular-nums">{line.qty_counted}</TableCell>
                    <TableCell className="tabular-nums">{line.stock_before}</TableCell>
                    <TableCell
                      className={cn(
                        "tabular-nums",
                        line.adjustment.startsWith("-") ? "text-destructive" : "text-foreground",
                      )}
                    >
                      {line.adjustment}
                    </TableCell>
                    <TableCell className="tabular-nums">{line.stock_after}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ) : null}
    </div>
  )
}

export default CountCapturePage
