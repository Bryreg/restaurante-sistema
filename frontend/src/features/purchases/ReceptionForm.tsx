/**
 * Captura de una recepción (`spec.md § Receptions`) — la pantalla más
 * difícil de esta misión, porque decide si el costo del restaurante es
 * real. Dos guardas de tecleo (`409 PRICE_LOOKS_LIKE_PACKAGE`,
 * `409 PRICE_JUMP`) PREGUNTAN y NUNCA corrigen el número solas: cuando el
 * servidor las dispara, esta pantalla congela el formulario, muestra lo que
 * se tecleó junto con la explicación del servidor, y ofrece dos caminos
 * explícitos — "volver a revisar" (nada se toca) o "confirmar que está
 * bien" (reenvía EXACTAMENTE el mismo precio, sólo con `confirm_price:
 * true`). Ningún camino ajusta, redondea ni "corrige" el número por su
 * cuenta.
 *
 * `Idempotency-Key`: una por intento de confirmación. Como el backend
 * guarda la respuesta (incluida una guarda `409`) bajo esa clave con el
 * hash EXACTO del cuerpo que la generó, reenviar el mismo cuerpo la reusa
 * (un doble toque no duplica la compra) pero reenviar un cuerpo DISTINTO
 * (p. ej. `confirm_price` pasa de `false` a `true`) bajo la misma clave
 * levantaría `IDEMPOTENCY_MISMATCH` — así que acá la clave rota cada vez
 * que el cuerpo efectivamente cambia, y sólo se reutiliza cuando se
 * reenvía el mismo cuerpo (ver `keyFor`).
 *
 * **Paso explícito "Continuar" antes de mostrar el `PinPad`.** `PinPad`
 * (compartido, `src/components/PinPad.tsx`) escucha el teclado a nivel de
 * `window` sin filtrar por foco — el mismo comportamiento documentado que
 * `frontend-cobro` ya tuvo que esquivar en `PaymentSplitsForm.tsx`. Ahí
 * alcanza con `disabled` porque su condición (`remaining !== 0`) no se
 * vuelve falsa a mitad de tecleo; acá NO alcanza: `canSubmit` se vuelve
 * `true` apenas el último campo obligatorio deja de estar vacío, que pasa
 * EN MITAD de tipear el precio de una línea (el primer dígito ya lo cumple).
 * Con el `PinPad` habilitado en ese instante, cada dígito que faltaba por
 * teclear del precio se colaría como dígito de PIN y dispararía un envío
 * prematuro con datos a medio escribir. Por eso acá el `PinPad` NUNCA se
 * monta mientras se edita: recién aparece después de un toque explícito en
 * "Continuar", que además bloquea el resto de los campos — a esa altura no
 * queda ningún campo de texto activo que pueda robarle dígitos.
 */

import { useMutation } from "@tanstack/react-query"
import { useRef, useState } from "react"

import { useSession } from "@/app/session"
import { ApiError, newIdempotencyKey } from "@/api/client"
import type { IngredientOut } from "@/api/inventory"
import { createReception, type ReceptionIn, type ReceptionOut, type SupplierOut } from "@/api/purchases"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PhotoCaptureField } from "@/components/PhotoCaptureField"
import { PinPad } from "@/components/PinPad"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"

import {
  draftsToReceptionLines,
  emptyReceptionLine,
  isReceptionLineComplete,
  ReceptionLinesEditor,
  type ReceptionLineDraft,
} from "./ReceptionLinesEditor"

const GUARD_CODES = new Set(["PRICE_LOOKS_LIKE_PACKAGE", "PRICE_JUMP"])

interface GuardState {
  code: "PRICE_LOOKS_LIKE_PACKAGE" | "PRICE_JUMP"
  message: string
  lineIndex: number | null
}

function parseLineIndex(message: string): number | null {
  const match = /^lines\[(\d+)\]/.exec(message)
  return match ? Number(match[1]) : null
}

export function ReceptionForm({
  storeId,
  suppliers,
  ingredients,
  onSuccess,
}: {
  storeId: number
  suppliers: SupplierOut[]
  ingredients: IngredientOut[]
  onSuccess: (reception: ReceptionOut) => void
}): React.JSX.Element {
  const { me } = useSession()
  const [supplierId, setSupplierId] = useState<number | null>(null)
  const [invoiceNumber, setInvoiceNumber] = useState("")
  const [invoiceDate, setInvoiceDate] = useState("")
  const [noInvoice, setNoInvoice] = useState(false)
  const [photo, setPhoto] = useState<string | null>(null)
  const [lines, setLines] = useState<ReceptionLineDraft[]>([emptyReceptionLine()])
  const [guard, setGuard] = useState<GuardState | null>(null)
  // Ver el docstring del módulo: el PinPad sólo se monta después de este paso.
  const [reviewing, setReviewing] = useState(false)

  const pinRef = useRef<string | null>(null)
  const idempotencyKeyRef = useRef<string>(newIdempotencyKey())
  const lastPayloadJsonRef = useRef<string | null>(null)

  function keyFor(payload: ReceptionIn): string {
    const json = JSON.stringify(payload)
    if (lastPayloadJsonRef.current !== json) {
      idempotencyKeyRef.current = newIdempotencyKey()
      lastPayloadJsonRef.current = json
    }
    return idempotencyKeyRef.current
  }

  const mutation = useMutation({
    mutationFn: (payload: ReceptionIn) => createReception(storeId, payload, keyFor(payload)),
    onSuccess: (reception) => {
      setGuard(null)
      onSuccess(reception)
    },
    onError: (err) => {
      if (err instanceof ApiError && GUARD_CODES.has(err.code)) {
        setGuard({ code: err.code as GuardState["code"], message: err.message, lineIndex: parseLineIndex(err.message) })
      } else {
        setGuard(null)
      }
    },
  })

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null
  const linesValid = lines.length > 0 && lines.every(isReceptionLineComplete)
  const canSubmit = supplierId !== null && invoiceDate.trim() !== "" && linesValid

  function buildPayload(confirmPrice: boolean, receivedByPin: string): ReceptionIn {
    return {
      supplier_id: supplierId as number,
      invoice_number: invoiceNumber.trim() === "" ? null : invoiceNumber.trim(),
      invoice_date: invoiceDate,
      no_invoice: noInvoice,
      photo,
      received_by_pin: receivedByPin,
      confirm_price: confirmPrice,
      lines: draftsToReceptionLines(lines),
    }
  }

  const guardLine = guard?.lineIndex !== null && guard?.lineIndex !== undefined ? lines[guard.lineIndex] : undefined
  const guardIngredient = guardLine ? ingredients.find((i) => i.id === guardLine.ingredientId) : undefined
  const formsDisabled = reviewing || guard !== null || mutation.isPending

  const nonGuardError =
    mutation.isError && !(mutation.error instanceof ApiError && GUARD_CODES.has(mutation.error.code))
      ? errorMessage(mutation.error)
      : null

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="rec-supplier">Proveedor</Label>
          <Select
            value={supplierId !== null ? String(supplierId) : undefined}
            onValueChange={(value) => setSupplierId(Number(value))}
            disabled={formsDisabled}
          >
            <SelectTrigger id="rec-supplier" className="w-full">
              <SelectValue placeholder="Elegí un proveedor" />
            </SelectTrigger>
            <SelectContent>
              {suppliers.map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {supplier?.invoices_required ? (
            <p className="text-xs text-muted-foreground">Este proveedor está marcado como obligado a facturar.</p>
          ) : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="rec-invoice-number">Número de factura {noInvoice ? "(opcional)" : ""}</Label>
          <Input
            id="rec-invoice-number"
            value={invoiceNumber}
            onChange={(event) => setInvoiceNumber(event.target.value)}
            disabled={formsDisabled}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="rec-invoice-date">{noInvoice ? "Fecha de la recepción" : "Fecha de factura"}</Label>
          <Input
            id="rec-invoice-date"
            type="date"
            required
            value={invoiceDate}
            onChange={(event) => setInvoiceDate(event.target.value)}
            disabled={formsDisabled}
          />
        </div>
        <div className="flex items-end">
          <div className="flex items-center gap-2">
            <Checkbox
              id="rec-no-invoice"
              checked={noInvoice}
              onCheckedChange={(checked) => setNoInvoice(checked === true)}
              disabled={formsDisabled}
            />
            <Label htmlFor="rec-no-invoice">Sin factura (plaza de mercado)</Label>
          </div>
        </div>
      </div>
      {noInvoice && supplier?.invoices_required ? (
        <p role="status" className="text-sm text-warning">
          «{supplier.name}» exige factura: si confirmás así, el servidor va a rechazar la recepción con «Falta la
          factura» — cargá número y fecha, o desmarcá «obligado a facturar» en el proveedor.
        </p>
      ) : null}

      <PhotoCaptureField value={photo} onChange={setPhoto} label="Foto de la factura (opcional)" disabled={formsDisabled} />

      <div className="space-y-2">
        <p className="text-sm font-medium">Líneas</p>
        <ReceptionLinesEditor
          lines={lines}
          onChange={setLines}
          ingredients={ingredients}
          disabled={formsDisabled}
          highlightIndex={guard?.lineIndex ?? null}
        />
      </div>

      {guard ? (
        <div role="alert" className="space-y-3 rounded-md border border-destructive/50 bg-destructive/5 p-4">
          <p className="text-sm font-semibold text-destructive">El precio no coincide con lo esperado</p>
          <p className="text-sm">{guard.message}</p>
          {guardLine ? (
            <p className="text-sm">
              <span className="text-muted-foreground">Lo que tecleaste para {guardIngredient?.name ?? "este insumo"}: </span>
              <span className="font-semibold tabular-nums">{guardLine.purchaseUnitPrice}</span>
              <span className="text-muted-foreground"> por unidad de compra.</span>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            El sistema no ajusta ni redondea este precio por su cuenta: sólo vos podés decidir si está bien o si hay
            que corregirlo. Confirmando queda registrado que lo revisaste vos
            {me?.kind === "admin" && me.user ? `, ${me.user.name}` : ""}.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setGuard(null)
                setReviewing(false)
              }}
            >
              Volver a revisar el precio
            </Button>
            <Button
              type="button"
              disabled={mutation.isPending || pinRef.current === null}
              onClick={() => {
                if (pinRef.current === null) return
                mutation.mutate(buildPayload(true, pinRef.current))
              }}
            >
              Confirmar que el precio es correcto
            </Button>
          </div>
        </div>
      ) : null}

      {!guard && !reviewing ? (
        <div className="flex flex-col items-center gap-2 rounded-md border p-4">
          <p className="text-sm text-muted-foreground">
            {canSubmit ? "Revisá los datos y continuá para ingresar el PIN." : "Completá proveedor, fecha y las líneas para poder confirmar."}
          </p>
          <Button type="button" disabled={!canSubmit} onClick={() => setReviewing(true)}>
            Continuar
          </Button>
        </div>
      ) : null}

      {!guard && reviewing ? (
        <div className="flex flex-col items-center gap-3 rounded-md border p-4">
          <p className="text-sm text-muted-foreground">PIN de quien recibió físicamente la mercancía</p>
          <PinPad
            length={4}
            label="PIN de quien recibe"
            disabled={mutation.isPending}
            errorMessage={nonGuardError}
            onSubmit={(pin) => {
              pinRef.current = pin
              mutation.mutate(buildPayload(false, pin))
            }}
          />
          <Button type="button" variant="ghost" size="sm" disabled={mutation.isPending} onClick={() => setReviewing(false)}>
            Volver a editar
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export default ReceptionForm
