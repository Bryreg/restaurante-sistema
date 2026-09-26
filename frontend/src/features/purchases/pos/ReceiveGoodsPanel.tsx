import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Check, Trash2 } from "lucide-react"
import { useId, useRef, useState } from "react"
import { toast } from "sonner"

import { newIdempotencyKey } from "@/api/client"
import {
  createReceptionDraft,
  getReceptionSuggestions,
  listDeviceReceptionIngredients,
  listDeviceSuppliers,
  listTodayReceptionDrafts,
  type DeviceReceptionIngredientOut,
  type ReceptionDraftOut,
  type ReceptionDraftStatus,
  type ReceptionSuggestionLine,
} from "@/api/purchases"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { MoneyInput } from "@/components/MoneyInput"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"
import { formatCantidad, formatFechaCorta } from "@/lib/format"
import { cn } from "@/lib/utils"
import { formatCOP } from "@/lib/money"

const TODAY_RECEPTION_DRAFTS_QUERY_KEY = ["purchases", "reception-drafts", "today"] as const

/** Cuántos insumos se muestran como resultado del buscador de una línea. */
const MAX_MATCHES = 8

interface LineDraft {
  key: string
  ingredientId: number | null
  search: string
  quantity: string
  lotCode: string
  expiresAt: string
  /** Lo que se esperaba (precargado del pedido aprobado o de la última compra). */
  expected: string | null
  /** Para una línea precargada: si llegó tal cual o distinto. `null` = sin marcar. */
  arrival: "same" | "different" | null
}

type PreloadSource = "request" | "last_purchase"

let nextKey = 0
function emptyLine(): LineDraft {
  nextKey += 1
  return {
    key: `rg-line-${nextKey}`,
    ingredientId: null,
    search: "",
    quantity: "",
    lotCode: "",
    expiresAt: "",
    expected: null,
    arrival: null,
  }
}

function expectedLine(s: ReceptionSuggestionLine): LineDraft {
  return { ...emptyLine(), ingredientId: s.ingredient_id, expected: s.quantity }
}

/** Nada escrito todavía: se puede precargar sin pisar lo de nadie. */
function pristine(lines: LineDraft[]): boolean {
  return lines.every((l) => l.expected === null && l.ingredientId === null && l.quantity.trim() === "")
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
}

const STATUS_LABEL: Record<ReceptionDraftStatus, string> = {
  pending: "Por completar",
  completed: "Completada",
  rejected: "Rechazada",
}

function statusText(d: ReceptionDraftOut): string {
  if (d.status === "rejected") return `Rechazada: ${d.rejected_reason ?? "sin motivo registrado"}`
  return STATUS_LABEL[d.status]
}

/**
 * **Recibir mercancía desde el POS** (decisión del dueño, 2026-09-25;
 * flag `purchases`).
 *
 * Cuando llega un proveedor, quien está en el turno registra lo que llegó:
 * proveedor (de la lista), número de factura o remisión —o «Sin factura»—,
 * **foto obligatoria** del papel, y las líneas (insumo, cantidad en su
 * unidad de compra y, si aplica, lote y vencimiento). **Sin ningún precio**:
 * los costos los pone el administrador cuando la completa, y recién ahí sube
 * el stock.
 *
 * Si se le pagó al proveedor de contado desde el cajón, se escribe el monto
 * que se le entregó: sale como egreso del turno en ese mismo momento (lo
 * registra el servidor). Esta pantalla no calcula nada: ni totales ni lo que
 * queda en el cajón.
 */
export function ReceiveGoodsPanel(): React.JSX.Element {
  const queryClient = useQueryClient()
  const baseId = useId()

  const suppliersQuery = useQuery({ queryKey: ["purchases", "device-suppliers"], queryFn: listDeviceSuppliers })
  const ingredientsQuery = useQuery({
    queryKey: ["purchases", "device-reception-ingredients"],
    queryFn: listDeviceReceptionIngredients,
  })
  const todayQuery = useQuery({ queryKey: TODAY_RECEPTION_DRAFTS_QUERY_KEY, queryFn: listTodayReceptionDrafts })

  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [noInvoice, setNoInvoice] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  // Mientras la foto se achica no se envía: saldría sin la foto que ya se ve elegida.
  const [photoProcessing, setPhotoProcessing] = useState(false)
  const [lines, setLines] = useState<LineDraft[]>(() => [emptyLine()])
  const [paidCash, setPaidCash] = useState<boolean | null>(null)
  const [preloaded, setPreloaded] = useState<PreloadSource | null>(null)
  const [cashAmount, setCashAmount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const idempotencyKeyRef = useRef(newIdempotencyKey())

  // Al elegir el proveedor, lo que se espera que llegue: lo aprobado en
  // Solicitudes o la última compra. Sin precios.
  const suggestionsQuery = useQuery({
    queryKey: ["purchases", "reception-suggestions", supplierId],
    queryFn: () => getReceptionSuggestions(supplierId as number),
    enabled: supplierId !== null,
  })
  const suggestions = suggestionsQuery.data ?? null

  function preload(source: PreloadSource) {
    if (!suggestions) return
    const rows = source === "request" ? suggestions.request_lines : suggestions.last_purchase_lines
    if (rows.length === 0) return
    setLines(rows.map(expectedLine))
    setPreloaded(source)
    setError(null)
  }

  // Precarga automática UNA vez por proveedor, y sólo si no se escribió nada
  // (ajuste de estado durante el render, apenas llegan las sugerencias).
  const [autoLoadedFor, setAutoLoadedFor] = useState<number | null>(null)
  if (suggestions && suggestions.supplier_id === supplierId && autoLoadedFor !== supplierId) {
    setAutoLoadedFor(supplierId)
    if (suggestions.source !== "none" && pristine(lines)) {
      const rows = suggestions.source === "request" ? suggestions.request_lines : suggestions.last_purchase_lines
      setLines(rows.map(expectedLine))
      setPreloaded(suggestions.source)
    }
  }

  const suppliers = suppliersQuery.data ?? []
  const ingredients = ingredientsQuery.data ?? []
  const today = todayQuery.data ?? []

  function reset() {
    setSupplierId(null)
    setInvoiceNumber("")
    setNoInvoice(false)
    setPhoto(null)
    setLines([emptyLine()])
    setPreloaded(null)
    setAutoLoadedFor(null)
    setPaidCash(null)
    setCashAmount(null)
    setError(null)
  }

  const mutation = useMutation({
    mutationFn: () =>
      createReceptionDraft(
        {
          supplier_id: supplierId as number,
          invoice_number: noInvoice || invoiceNumber.trim() === "" ? null : invoiceNumber.trim(),
          no_invoice: noInvoice,
          photo: photo as string,
          cash_paid_amount: paidCash ? cashAmount : null,
          lines: lines
            .filter((l) => l.ingredientId !== null && l.quantity.trim() !== "")
            .map((l) => ({
              ingredient_id: l.ingredientId as number,
              quantity: l.quantity.trim(),
              lot_code: l.lotCode.trim() === "" ? null : l.lotCode.trim(),
              expires_at: l.expiresAt.trim() === "" ? null : l.expiresAt.trim(),
            })),
        },
        idempotencyKeyRef.current,
      ),
    onSuccess: () => {
      toast.success("Recepción registrada. Queda por completar por el administrador.")
      idempotencyKeyRef.current = newIdempotencyKey()
      reset()
      void queryClient.invalidateQueries({ queryKey: TODAY_RECEPTION_DRAFTS_QUERY_KEY })
      // Si se pagó del cajón, el esperado del turno cambió: lo recalcula el servidor.
      void queryClient.invalidateQueries({ queryKey: ["shifts"] })
    },
    onError: (err) => {
      // La respuesta del servidor es final: el próximo intento es otro.
      idempotencyKeyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((current) => current.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (photoProcessing) return
    if (supplierId === null) return setError("Elegí el proveedor.")
    if (!noInvoice && invoiceNumber.trim() === "") return setError("Escribí el número de la factura o remisión, o marcá «Sin factura».")
    if (!photo) return setError("Tomale una foto a la factura o remisión: es obligatoria.")
    if (lines.some((l) => l.expected !== null && l.arrival === null)) {
      return setError("Marcá en cada insumo si llegó tal cual o distinto (o quitalo si no llegó).")
    }
    const complete = lines.filter((l) => l.ingredientId !== null && l.quantity.trim() !== "")
    if (complete.length === 0) return setError("Agregá al menos un insumo con su cantidad.")
    if (complete.length !== lines.length) return setError("Hay una línea sin insumo o sin cantidad: completala o quitala.")
    if (paidCash === null) return setError("Decí si pagaste de contado desde la caja.")
    if (paidCash && (cashAmount === null || cashAmount <= 0)) return setError("Escribí cuánto le entregaste al proveedor.")
    setError(null)
    mutation.mutate()
  }

  if (suppliersQuery.isLoading || ingredientsQuery.isLoading) {
    return <Cargando texto="Cargando proveedores e insumos…" />
  }
  if (suppliersQuery.isError || ingredientsQuery.isError) {
    return (
      <EmptyState
        reason="error"
        title="No se pudieron cargar los proveedores o los insumos"
        description={errorMessage(suppliersQuery.error ?? ingredientsQuery.error)}
        action={{
          label: "Reintentar",
          onClick: () => {
            void suppliersQuery.refetch()
            void ingredientsQuery.refetch()
          },
        }}
      />
    )
  }

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null
  const disabled = mutation.isPending

  return (
    <div className="space-y-6">
      {suppliers.length === 0 ? (
        <EmptyState
          title="Todavía no hay proveedores activos"
          description="El administrador tiene que crear el proveedor en Compras antes de poder recibirle mercancía acá."
        />
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4" noValidate>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor={`${baseId}-supplier`}>Proveedor</Label>
              <Select
                value={supplierId !== null ? String(supplierId) : undefined}
                onValueChange={(value) => setSupplierId(Number(value))}
                disabled={disabled}
              >
                <SelectTrigger id={`${baseId}-supplier`} aria-label="Proveedor" className="h-11 w-full">
                  <SelectValue placeholder="Elegí el proveedor" />
                </SelectTrigger>
                <SelectContent>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor={`${baseId}-invoice`}>Número de factura o remisión</Label>
              <Input
                id={`${baseId}-invoice`}
                className="h-11"
                value={noInvoice ? "" : invoiceNumber}
                onChange={(event) => setInvoiceNumber(event.target.value)}
                disabled={disabled || noInvoice}
              />
              <div className="flex min-h-11 items-center gap-2">
                <Checkbox
                  id={`${baseId}-no-invoice`}
                  aria-label="Sin factura"
                  checked={noInvoice}
                  onCheckedChange={(checked) => setNoInvoice(checked === true)}
                  disabled={disabled}
                />
                <Label htmlFor={`${baseId}-no-invoice`}>Sin factura</Label>
              </div>
              {noInvoice && supplier?.invoices_required ? (
                <p className="text-xs text-muted-foreground">
                  Este proveedor tiene que facturar: el administrador le va a pedir la factura.
                </p>
              ) : null}
            </div>

            <div className="sm:col-span-2">
              <PhotoCaptureField
                value={photo}
                onChange={setPhoto}
                label="Foto de la factura o remisión"
                required
                disabled={disabled}
                onProcessingChange={setPhotoProcessing}
              />
            </div>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">¿Qué llegó?</legend>
            {suggestions && (suggestions.request_lines.length > 0 || suggestions.last_purchase_lines.length > 0) ? (
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">
                  {preloaded === "request"
                    ? "Precargado con lo aprobado en Solicitudes."
                    : preloaded === "last_purchase"
                      ? `Precargado con la última compra${suggestions.last_purchase_date ? ` (${formatFechaCorta(suggestions.last_purchase_date)})` : ""}.`
                      : "Podés precargar lo que se esperaba:"}
                </span>
                {suggestions.request_lines.length > 0 && preloaded !== "request" ? (
                  <Button type="button" variant="outline" className="h-11" disabled={disabled} onClick={() => preload("request")}>
                    Cargar lo aprobado ({suggestions.request_lines.length})
                  </Button>
                ) : null}
                {suggestions.last_purchase_lines.length > 0 && preloaded !== "last_purchase" ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled}
                    onClick={() => preload("last_purchase")}
                  >
                    Cargar la última compra ({suggestions.last_purchase_lines.length})
                  </Button>
                ) : null}
              </div>
            ) : null}
            {lines.map((line, index) => (
              <LineEditor
                key={line.key}
                index={index}
                line={line}
                ingredients={ingredients}
                disabled={disabled}
                canRemove={lines.length > 1 || line.expected !== null}
                onChange={(patch) => updateLine(line.key, patch)}
                onRemove={() =>
                  setLines((current) => {
                    const next = current.filter((l) => l.key !== line.key)
                    return next.length > 0 ? next : [emptyLine()]
                  })
                }
              />
            ))}
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={disabled}
              onClick={() => setLines((current) => [...current, emptyLine()])}
            >
              Agregar otro insumo
            </Button>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">¿Pagaste de contado desde la caja?</legend>
            <div className="flex gap-2">
              <Button
                type="button"
                className="h-11 flex-1"
                variant={paidCash === true ? "default" : "outline"}
                aria-pressed={paidCash === true}
                disabled={disabled}
                onClick={() => setPaidCash(true)}
              >
                Sí, pagué de la caja
              </Button>
              <Button
                type="button"
                className="h-11 flex-1"
                variant={paidCash === false ? "default" : "outline"}
                aria-pressed={paidCash === false}
                disabled={disabled}
                onClick={() => {
                  setPaidCash(false)
                  setCashAmount(null)
                }}
              >
                No
              </Button>
            </div>
            {paidCash ? (
              <div className="space-y-1">
                <Label htmlFor={`${baseId}-cash`}>Monto que le entregaste</Label>
                <MoneyInput id={`${baseId}-cash`} value={cashAmount} onChange={setCashAmount} disabled={disabled} />
                <p className="text-xs text-muted-foreground">Sale del cajón como pago a proveedor en este turno.</p>
              </div>
            ) : null}
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <Button type="submit" className="h-11 w-full" disabled={disabled || photoProcessing}>
            {mutation.isPending ? "Registrando…" : photoProcessing ? "Procesando foto…" : "Registrar lo que llegó"}
          </Button>
          <p className="text-xs text-muted-foreground">
            No lleva precios: el administrador la completa con los costos, y recién ahí sube el inventario.
          </p>
        </form>
      )}

      <section className="space-y-2" aria-labelledby={`${baseId}-today`}>
        <h2 id={`${baseId}-today`} className="text-sm font-medium">
          Recibido hoy
        </h2>
        {todayQuery.isError ? (
          <p role="alert" className="text-sm text-destructive">
            No se pudo cargar lo recibido hoy: {errorMessage(todayQuery.error)}
          </p>
        ) : today.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no se registró ninguna recepción hoy.</p>
        ) : (
          <ul className="space-y-2">
            {today.map((d) => (
              <li key={d.id} className="rounded-md border p-3 text-sm">
                <p className="flex flex-wrap items-baseline justify-between gap-2">
                  <b>{d.supplier_name}</b>
                  <span className={d.status === "rejected" ? "text-destructive" : "text-muted-foreground"}>
                    {statusText(d)}
                  </span>
                </p>
                <p className="text-muted-foreground">
                  {d.no_invoice ? "Sin factura" : `Factura ${d.invoice_number ?? "—"}`} · {d.created_by_employee_name}
                  {d.cash_paid_amount !== null ? ` · pagado de la caja ${formatCOP(d.cash_paid_amount)}` : ""}
                </p>
                <p>
                  {d.lines.map((l) => `${formatCantidad(l.quantity, l.purchase_unit)} de ${l.ingredient_name}`).join(" · ")}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function LineEditor({
  index,
  line,
  ingredients,
  disabled,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number
  line: LineDraft
  ingredients: DeviceReceptionIngredientOut[]
  disabled: boolean
  canRemove: boolean
  onChange: (patch: Partial<LineDraft>) => void
  onRemove: () => void
}): React.JSX.Element {
  const rowId = useId()
  const chosen = ingredients.find((i) => i.id === line.ingredientId) ?? null
  const esperada = line.expected !== null && chosen !== null
  const query = normalize(line.search)
  const matches =
    chosen || query === "" ? [] : ingredients.filter((i) => normalize(i.name).includes(query)).slice(0, MAX_MATCHES)

  return (
    <div className="space-y-3 rounded-md border p-3" data-testid={`receive-line-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">Insumo {index + 1}</p>
        {canRemove ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-11"
            aria-label={`Quitar insumo ${index + 1}`}
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      {esperada ? (
        <div className="space-y-2">
          <p className="text-sm">
            <b>{chosen.name}</b>{" "}
            <span className="text-muted-foreground">
              · se esperaba {formatCantidad(line.expected, chosen.purchase_unit)}
            </span>
          </p>
          <div className="grid grid-cols-2 gap-2" role="group" aria-label={`¿Cómo llegó ${chosen.name}?`}>
            <button
              type="button"
              aria-pressed={line.arrival === "same"}
              disabled={disabled}
              onClick={() => onChange({ arrival: "same", quantity: line.expected ?? "" })}
              className={cn(
                "flex min-h-12 items-center justify-center gap-2 rounded-lg px-3 text-base font-semibold ring-1 transition-colors",
                line.arrival === "same" ? "bg-foreground text-background ring-foreground" : "bg-card ring-border hover:bg-muted",
              )}
            >
              {line.arrival === "same" ? <Check aria-hidden="true" className="size-5" /> : null}
              Llegó
            </button>
            <button
              type="button"
              aria-pressed={line.arrival === "different"}
              disabled={disabled}
              onClick={() => onChange({ arrival: "different", quantity: "" })}
              className={cn(
                "min-h-12 rounded-lg px-3 text-base font-semibold ring-1 transition-colors",
                line.arrival === "different" ? "bg-foreground text-background ring-foreground" : "bg-card ring-border hover:bg-muted",
              )}
            >
              Llegó distinto
            </button>
          </div>
        </div>
      ) : chosen ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm">
            <b>{chosen.name}</b> <span className="text-muted-foreground">· se compra por {chosen.purchase_unit}</span>
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11"
            disabled={disabled}
            onClick={() => onChange({ ingredientId: null, search: "" })}
          >
            Cambiar insumo
          </Button>
        </div>
      ) : (
        <div className="space-y-1">
          <Label htmlFor={`${rowId}-search`}>Buscar insumo</Label>
          <Input
            id={`${rowId}-search`}
            className="h-11"
            value={line.search}
            onChange={(event) => onChange({ search: event.target.value })}
            placeholder="Escribí parte del nombre"
            autoComplete="off"
            disabled={disabled}
          />
          {query !== "" && matches.length === 0 ? (
            <p className="text-xs text-muted-foreground">Ningún insumo activo se llama así.</p>
          ) : null}
          {matches.length > 0 ? (
            <ul className="flex flex-wrap gap-2" aria-label="Insumos que coinciden">
              {matches.map((i) => (
                <li key={i.id}>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={disabled}
                    onClick={() => onChange({ ingredientId: i.id, search: "" })}
                  >
                    {i.name}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}

      <div className={cn("grid gap-3 sm:grid-cols-3", esperada && line.arrival === null && "hidden")}>
        <div className={cn("space-y-1", esperada && line.arrival === "same" && "hidden")}>
          <Label htmlFor={`${rowId}-qty`}>
            {esperada ? "Cantidad que llegó" : "Cantidad"}
            {chosen ? ` (${chosen.purchase_unit})` : ""}
          </Label>
          <Input
            id={`${rowId}-qty`}
            className="h-11"
            inputMode="decimal"
            value={line.quantity}
            onChange={(event) => onChange({ quantity: event.target.value })}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${rowId}-lot`}>Lote (opcional)</Label>
          <Input
            id={`${rowId}-lot`}
            className="h-11"
            value={line.lotCode}
            onChange={(event) => onChange({ lotCode: event.target.value })}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${rowId}-expires`}>Vence (opcional)</Label>
          <Input
            id={`${rowId}-expires`}
            className="h-11"
            type="date"
            value={line.expiresAt}
            onChange={(event) => onChange({ expiresAt: event.target.value })}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  )
}

export default ReceiveGoodsPanel
