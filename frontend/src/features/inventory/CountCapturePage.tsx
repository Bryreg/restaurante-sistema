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
  type CountApplyLineOut,
  type CountApplyOut,
  type CountLineOut,
  type CountLineRefIn,
  type CountDetailOut,
} from "@/api/inventory"
import {
  ConsequenceZone,
  DenseTable,
  DenseTableBar,
  GroupLabel,
  PageHeader,
  TimeAgo,
  type DenseColumn,
  type LegendEntry,
  type RowStatus,
} from "@/components/admin"
import { EmptyState } from "@/components/EmptyState"
import { PinPad } from "@/components/PinPad"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { cn } from "@/lib/utils"

import { parseCountInput } from "./lib"

const UNIT_LABEL: Record<string, string> = { g: "g", ml: "ml", unit: "unidad" }

function queryKeyFor(storeId: number | null, countId: number) {
  return ["inventory", "count", storeId, countId] as const
}

const LEGEND: readonly LegendEntry[] = [
  {
    term: "Sin confirmar",
    meaning: (
      <>
        <b>no es cero</b>: es que todavía nadie contó ese renglón. Un renglón en blanco y uno contado en cero
        son cosas distintas.
      </>
    ),
  },
  {
    term: "Conteo anterior",
    meaning:
      "la única referencia que esta pantalla muestra. No es el stock del sistema: el conteo es a ciegas a propósito.",
  },
  {
    term: "6+8 · 3,5",
    meaning: "el campo acepta sumas y decimales con coma. Es ayuda de tecleo; el servidor vuelve a validar.",
  },
]

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
 * - **Un guardado parcial lo dice**: la franja de contexto usa
 *   `lines_counted`/`lines_total` tal como los manda el servidor, siempre
 *   visible mientras falte algún renglón — no sólo justo después de guardar.
 *
 * **Sobre el color del botón** (`docs/PATRONES-ADMIN.md` § 11): «Aplicar
 * conteo» dejó de ser un botón rojo. El peligro va **en el marco** —zona
 * roja, «no se deshace»— y el control sigue siendo **azul y secundario**,
 * para que no sea lo más fácil de pulsar. Si lo rojo fuera el botón, el rojo
 * dejaría de querer decir «esto no se deshace» y pasaría a querer decir
 * «botón importante».
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
        old
          ? {
              ...old,
              lines: result.lines,
              lines_total: result.lines_total,
              lines_counted: result.lines_counted,
            }
          : old,
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
    mutationFn: (pin: string) =>
      postApplyCount(countId, activeStoreId as number, pin, applyIdempotencyKeyRef.current),
    onSuccess: (result) => {
      setApplyResult(result)
      setApplyOpen(false)
      toast.success("Conteo aplicado.")
      void queryClient.invalidateQueries({
        queryKey: queryKeyFor(activeStoreId, countId),
      })
      void queryClient.invalidateQueries({
        queryKey: ["inventory", "counts", activeStoreId],
      })
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
      setRowError((prev) => ({
        ...prev,
        [line.ingredient_id]: "Cantidad inválida — revisá el valor.",
      }))
      return
    }
    saveMutation.mutate([
      {
        ingredient_id: line.ingredient_id,
        qty_counted: parsed.value,
        was_counted: true,
      },
    ])
  }

  function saveDraftProgress(): void {
    const lines: CountLineRefIn[] = []
    const nextErrors: Record<number, string> = {}
    for (const [idText, text] of Object.entries(drafts)) {
      const ingredientId = Number(idText)
      if (text.trim() === "") continue
      const parsed = parseCountInput(text)
      if (parsed.valid && parsed.value !== null) {
        lines.push({
          ingredient_id: ingredientId,
          qty_counted: parsed.value,
          was_counted: false,
        })
      } else {
        nextErrors[ingredientId] = "Cantidad inválida — revisá el valor."
      }
    }
    setRowError((prev) => ({ ...prev, ...nextErrors }))
    if (lines.length > 0) saveMutation.mutate(lines)
  }

  const isOpen = count.status === "open"
  const hasPartial = count.lines_counted < count.lines_total

  function lineStatus(line: CountLineOut): RowStatus {
    return line.was_counted ? "ok" : "warning"
  }

  const columns: readonly DenseColumn<CountLineOut>[] = [
    {
      key: "name",
      header: "Insumo",
      kind: "name",
      cell: (l) => l.ingredient_name,
    },
    {
      key: "previous",
      header: "Conteo anterior",
      kind: "number",
      cell: (l) =>
        l.previous_qty_counted !== null ? (
          `${l.previous_qty_counted} ${UNIT_LABEL[l.base_unit] ?? l.base_unit}`
        ) : (
          <span className="text-muted-foreground italic">Sin conteo anterior</span>
        ),
    },
    {
      key: "qty",
      header: "Cantidad contada",
      widthPx: 200,
      cell: (line) => {
        const draft = draftFor(line)
        const parsed = parseCountInput(draft)
        const invalid = draft.trim() !== "" && !parsed.valid
        const error = rowError[line.ingredient_id]
        return (
          <Input
            inputMode="decimal"
            className="h-7 w-36"
            placeholder="p. ej. 6+8 ó 3,5"
            value={draft}
            disabled={!isOpen}
            aria-invalid={invalid || Boolean(error)}
            aria-label={`Cantidad contada — ${line.ingredient_name}`}
            title={error ?? (invalid ? "Cantidad inválida — no se envía." : undefined)}
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
        )
      },
    },
    {
      key: "state",
      header: "Estado",
      cell: (l) => (
        <span className="inline-flex items-center gap-1.5">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", l.was_counted ? "bg-success" : "bg-warning")}
            aria-hidden="true"
          />
          {l.was_counted ? "Confirmado" : "Sin confirmar"}
        </span>
      ),
    },
    {
      key: "action",
      header: "",
      kind: "actions",
      cell: (line) => {
        const draft = draftFor(line)
        const parsed = parseCountInput(draft)
        return (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!isOpen || draft.trim() === "" || !parsed.valid || saveMutation.isPending}
            onClick={() => confirmLine(line)}
          >
            Confirmar
          </Button>
        )
      },
    },
  ]

  const applyColumns: readonly DenseColumn<CountApplyLineOut>[] = [
    {
      key: "name",
      header: "Insumo",
      kind: "name",
      cell: (l) => l.ingredient_name,
    },
    {
      key: "counted",
      header: "Contado",
      kind: "number",
      cell: (l) => l.qty_counted,
    },
    {
      key: "before",
      header: "Stock antes",
      kind: "number",
      cell: (l) => l.stock_before,
    },
    {
      key: "adjustment",
      header: "Ajuste",
      kind: "number",
      cell: (l) => (
        <span className={cn(l.adjustment.startsWith("-") && "font-bold text-destructive")}>
          {l.adjustment}
        </span>
      ),
    },
    {
      key: "after",
      header: "Stock después",
      kind: "number",
      cell: (l) => l.stock_after,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        name={`Conteo #${count.id}`}
        question="Cuánto hay de verdad, contado a mano. Lo que se teclee acá es lo que el sistema va a creer cuando el conteo se aplique."
        context={[
          {
            label: "Alcance",
            value: count.scope === "key_items" ? "Críticos" : "Completo",
          },
          { label: "Abierto por", value: count.opened_by_employee_name },
          {
            label: "Abierto",
            value: <TimeAgo iso={count.opened_at} />,
            title: formatInstant(count.opened_at),
          },
        ]}
        actions={
          <Link
            to="/admin/inventario?tab=conteos"
            className="text-sm text-primary underline underline-offset-2"
          >
            Volver a conteos
          </Link>
        }
      />

      <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
        Conteo <strong>a ciegas</strong>: esta pantalla no muestra el stock del sistema. La única referencia
        es el <strong>conteo anterior</strong> de cada insumo, cuando existe. Es a propósito: si vieras lo
        esperado, contarías hasta que coincida.
      </div>

      {/* Los avisos de estado del conteo. Son «estados que no son la
          pantalla llena» (`docs/INVENTARIO-CONTROLES.md` § 22) y de los más
          fáciles de perder: viven acá, con sus palabras, y NO disueltos en
          la franja de contexto — un renglón más entre otros cuatro deja de
          leerse como el aviso que es. */}
      {hasPartial ? (
        <div role="status" className="rounded-md border border-dashed p-3 text-sm">
          <strong>Guardado parcial:</strong> {count.lines_counted} de {count.lines_total} renglones
          confirmados.
        </div>
      ) : (
        <div role="status" className="rounded-md border p-3 text-sm text-muted-foreground">
          Todos los renglones ({count.lines_total}) están confirmados.
        </div>
      )}

      {count.status === "applied" ? (
        <div role="status" className="rounded-md border p-3 text-sm">
          Este conteo ya se aplicó — {formatInstant(count.applied_at)} por {count.applied_by_employee_name}.
          No se puede volver a capturar ni a aplicar.
        </div>
      ) : null}

      <DenseTable
        caption={`Renglones del conteo #${count.id}`}
        columns={columns}
        rows={count.lines}
        rowKey={(l) => String(l.ingredient_id)}
        rowStatus={lineStatus}
        legend={LEGEND}
        bar={
          <DenseTableBar
            shown={count.lines_counted}
            total={count.lines_total}
            noun="renglones confirmados"
            hidden={hasPartial ? `${count.lines_total - count.lines_counted} todavía sin contar` : undefined}
          >
            {isOpen ? (
              <>
                {saveMutation.isError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {errorMessage(saveMutation.error)}
                  </p>
                ) : null}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={saveMutation.isPending}
                  onClick={saveDraftProgress}
                >
                  {saveMutation.isPending ? "Guardando…" : "Guardar avance (sin confirmar)"}
                </Button>
              </>
            ) : null}
          </DenseTableBar>
        }
        empty={<EmptyState title="Sin datos" description="Este conteo no tiene renglones." />}
      />

      {isOpen ? (
        /* Patrón 11 · Rojo · «Zona de riesgo»: no se deshace. El peligro va
           en el MARCO; el botón es azul y secundario, y la confirmación
           enumera qué cambia y dónde se va a notar. Después de la
           enumeración todavía hace falta el PIN de administrador: el gate
           del backend no se reemplaza, se refleja. */
        <ConsequenceZone
          level="irreversible"
          scope={`Conteo #${count.id}`}
          explanation={
            <>
              Aplicar el conteo ajusta el stock a «contado + (entradas − salidas desde el instante del
              conteo)». <b>Se hace una sola vez y no se deshace.</b> Lo que quede sin confirmar no se toca.
            </>
          }
        >
          {/* La zona se usa **sin** su `action` a propósito. Su `action`
              dibuja su propio diálogo de confirmación, y acá la
              confirmación que manda es el **PIN de administrador** que exige
              el backend: encadenar los dos pondría dos diálogos seguidos y
              un clic de más en una pantalla que ya existía. Así que las
              consecuencias se enumeran **a la vista** —mejor que
              escondidas detrás de un clic— y el botón abre directamente el
              PIN, igual que antes. Lo que sí cambia es el color: era
              `destructive` (rojo) y ahora es **azul y secundario**, con el
              peligro en el marco (`docs/PATRONES-ADMIN.md` § 11). */}
          <p className="mb-2 text-xs font-bold text-foreground">Qué cambia y dónde se va a notar:</p>
          <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
            <li>
              Ajusta el stock de los <b>{count.lines_counted}</b> renglones confirmados, y deja los demás como
              están.
            </li>
            <li>Deja un movimiento con causa «Ajuste por conteo» en el libro de cada insumo.</li>
            <li>Habilita la varianza contra el conteo aplicado anterior, en la pestaña Varianza.</li>
            <li>No se deshace: para corregirlo hace falta otro conteo, o un ajuste manual con su motivo.</li>
          </ul>
          {hasPartial ? (
            <p className="mt-2 text-xs text-muted-foreground">
              Quedan <b>{count.lines_total - count.lines_counted}</b> renglones sin confirmar. Se puede
              aplicar igual: los que nadie contó no se ajustan.
            </p>
          ) : null}
          <Button
            type="button"
            variant="outline"
            className="mt-3 border-primary/40 text-primary hover:bg-accent hover:text-primary"
            onClick={() => {
              applyMutation.reset()
              setApplyOpen(true)
            }}
          >
            Aplicar conteo
          </Button>
        </ConsequenceZone>
      ) : null}

      <Dialog
        open={applyOpen}
        onOpenChange={(next) => {
          setApplyOpen(next)
          if (!next) applyMutation.reset()
        }}
      >
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

      {applyResult ? (
        <GroupLabel label="Ajuste aplicado" says="ya movió el stock — esto es lo que cambió">
          <DenseTable
            caption="Ajuste aplicado por el conteo"
            columns={applyColumns}
            rows={applyResult.lines}
            rowKey={(l) => String(l.ingredient_id)}
            rowStatus={(l) => (l.adjustment.startsWith("-") ? "critical" : "none")}
            note="Un ajuste negativo es stock que el sistema creía tener y no estaba. Queda explicado en el libro de movimientos de cada insumo, con causa «Ajuste por conteo»."
          />
        </GroupLabel>
      ) : null}
    </div>
  )
}

export default CountCapturePage
