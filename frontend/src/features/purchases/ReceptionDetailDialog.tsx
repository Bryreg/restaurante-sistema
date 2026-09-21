import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { IngredientOut } from "@/api/inventory"
import { reverseReception, type ReceptionOut, type SupplierOut } from "@/api/purchases"
import {
  ConsequenceZone,
  DenseTable,
  type DenseColumn,
  type LegendEntry,
} from "@/components/admin"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP, formatCOPDecimal } from "@/lib/money"

import { RECEPTION_STATUS_LABEL, supplierName } from "./lib"

/**
 * **El botón es azul y secundario** (patrón 11, y `docs/DISENO.md` § La regla
 * del color). Revertir una recepción es de lo más destructivo que tiene el
 * admin, y justamente por eso el rojo va **en el marco** de la zona y no en
 * el botón: un botón rojo le enseña al dueño que el rojo es algo que se
 * toca, y el día que aparezca para decir «esta cuenta está vencida» no lo va
 * a leer.
 */
const AZUL_Y_SECUNDARIO = "border-primary/40 text-primary hover:bg-accent hover:text-primary"

function ingredientName(ingredients: IngredientOut[], id: number): string {
  return ingredients.find((i) => i.id === id)?.name ?? `Insumo #${id}`
}

/** La leyenda del pie: las tres cifras de una línea NO son la misma cifra. */
const LINES_LEGEND: readonly LegendEntry[] = [
  {
    term: "Recibido ≠ facturado",
    meaning: (
      <>
        lo que entró al depósito y lo que el proveedor cobró se guardan <b>por separado</b>. El stock se mueve
        con lo recibido; la cuenta por pagar nace de lo facturado.
      </>
    ),
  },
  {
    term: "Costo final",
    meaning: (
      <>
        no es el precio de compra: es lo que el servidor dejó en el insumo después de repartir el impuesto y la
        unidad de compra. <b>Esta pantalla no lo calcula</b>, lo muestra.
      </>
    ),
  },
  {
    term: "Lote «—»",
    meaning: "esta línea entró sin lote ni vencimiento, no que el lote sea cero. Sin lote no hay trazabilidad de esa mercancía.",
  },
]

/**
 * Eliminar una recepción muestra QUÉ se va a revertir (sus propias líneas,
 * ya traídas — nada nuevo se calcula acá) ANTES de pedir el PIN, y explica
 * en castellano por qué no se puede si el backend contesta
 * `409 LOT_CONSUMED` o `409 PAYABLE_HAS_PAYMENTS` (spec.md § Receptions).
 * Nada se borra de fila: la reversa es un movimiento con causa propia.
 *
 * Va envuelta en la **zona roja** del patrón 11 porque es exactamente su
 * caso —«Revertir recepción» está nombrada ahí—: el marco avisa, enumera lo
 * que cambia y dónde se nota, y el botón sigue siendo azul.
 */
function ReverseReceptionAction({
  reception,
  ingredients,
  onReversed,
}: {
  reception: ReceptionOut
  ingredients: IngredientOut[]
  onReversed: () => void
}): React.JSX.Element {
  const [pin, setPin] = useState("")

  const mutation = useMutation({
    mutationFn: () => reverseReception(reception.id, { authorizer_pin: pin.trim() }),
    onSuccess: () => {
      setPin("")
      onReversed()
    },
  })

  return (
    <ConsequenceZone
      level="irreversible"
      scope={`Recepción #${reception.id}`}
      explanation={
        <>
          Revertir deja un movimiento de reversa por cada línea y cancela la cuenta por pagar si no tiene pagos
          vivos. <b>No se deshace</b>: para volver atrás hay que cargar la recepción otra vez, a mano. Si algún
          lote ya se consumió, el servidor la rechaza.
        </>
      }
    >
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) mutation.reset()
        }}
      >
        <AlertDialogTrigger render={<Button type="button" variant="outline" className={AZUL_Y_SECUNDARIO} />}>
          Eliminar recepción
        </AlertDialogTrigger>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Esto es lo que se va a revertir</AlertDialogTitle>
            <AlertDialogDescription>
              No se borra ninguna fila: queda un movimiento de reversa por cada línea, y la cuenta por pagar
              asociada se cancela si no tiene pagos vivos.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
            {reception.lines.map((line) => (
              <li key={line.id} className="flex justify-between gap-2">
                {/* La palabra del negocio, no el id: «Pechuga», no «Insumo #5». */}
                <span>{ingredientName(ingredients, line.ingredient_id)}</span>
                <span className="text-muted-foreground tabular-nums">
                  {line.qty_received} recibido{line.lot_code ? ` · lote ${line.lot_code}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {reception.payable_id !== null ? (
            <p className="text-sm text-muted-foreground">
              Esta recepción tiene una cuenta por pagar asociada (#{reception.payable_id}). Si ya tiene pagos
              vivos, la reversa se rechaza — hay que anular esos pagos primero.
            </p>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="rec-reverse-pin">PIN de administrador</Label>
            <Input
              id="rec-reverse-pin"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(event) => setPin(event.target.value)}
            />
          </div>
          {mutation.isError ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorMessage(mutation.error)}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="outline"
              className={AZUL_Y_SECUNDARIO}
              disabled={pin.trim() === "" || mutation.isPending}
              onClick={() => mutation.mutate()}
            >
              Eliminar recepción
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConsequenceZone>
  )
}

export function ReceptionDetailDialog({
  reception,
  suppliers,
  ingredients,
}: {
  reception: ReceptionOut
  suppliers: SupplierOut[]
  ingredients: IngredientOut[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["purchases", "receptions"] })
    void queryClient.invalidateQueries({ queryKey: ["purchases", "payables"] })
  }

  const columns: readonly DenseColumn<(typeof reception.lines)[number]>[] = [
    {
      key: "ingredient",
      header: "Insumo",
      kind: "name",
      cell: (line) => ingredientName(ingredients, line.ingredient_id),
    },
    { key: "received", header: "Recibido", kind: "number", cell: (line) => line.qty_received },
    { key: "invoiced", header: "Facturado", kind: "number", cell: (line) => line.qty_invoiced },
    {
      key: "price",
      header: "Precio compra",
      kind: "number",
      cell: (line) => formatCOPDecimal(line.purchase_unit_price),
    },
    {
      key: "final",
      header: "Costo final",
      kind: "number",
      cell: (line) => formatCOPDecimal(line.final_unit_cost),
    },
    {
      key: "tax",
      header: "IVA/INC",
      kind: "number",
      cell: (line) => `${line.tax_rate}% · ${formatCOP(line.tax_amount)}`,
    },
    { key: "lot", header: "Lote", kind: "id", cell: (line) => line.lot_code ?? "—" },
    {
      key: "expires",
      header: "Vence",
      cell: (line) => (line.expires_at ? formatBusinessDate(line.expires_at) : "—"),
    },
  ]

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Ver</DialogTrigger>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            Recepción #{reception.id} · {supplierName(suppliers, reception.supplier_id)}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
            <div>
              <p className="text-muted-foreground">Estado</p>
              <Badge variant={reception.status === "confirmed" ? "secondary" : "outline"}>
                {RECEPTION_STATUS_LABEL[reception.status]}
              </Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Factura</p>
              <p>{reception.no_invoice ? "Sin factura" : (reception.invoice_number ?? "—")}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Fecha</p>
              <p>{formatBusinessDate(reception.invoice_date)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Recibió</p>
              <p>{reception.received_by_employee_name}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Día operativo</p>
              <p>{formatBusinessDate(reception.business_date)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Cuenta por pagar</p>
              <p>{reception.payable_id !== null ? `#${reception.payable_id}` : "—"}</p>
            </div>
            {reception.price_confirmed ? (
              <div className="sm:col-span-3">
                <p className="text-muted-foreground">Precio confirmado tras una guarda</p>
                <p>por {reception.price_confirmed_by_employee_name ?? "—"}</p>
              </div>
            ) : null}
            {reception.status === "reversed" ? (
              <div className="sm:col-span-3">
                <p className="text-muted-foreground">Revertida</p>
                <p>
                  {formatInstant(reception.reversed_at)} por {reception.reversed_by_employee_name ?? "—"}
                </p>
              </div>
            ) : null}
          </div>

          <DenseTable
            caption={`Líneas de la recepción #${reception.id}`}
            columns={columns}
            rows={reception.lines}
            rowKey={(line) => String(line.id)}
            // La franja marca la línea donde lo recibido y lo facturado no
            // coinciden: es la forma del problema, sin leer los números.
            rowStatus={(line) => (line.qty_received !== line.qty_invoiced ? "warning" : "none")}
            legend={LINES_LEGEND}
            maxBodyHeightPx={320}
            className="min-w-0"
          />

          {reception.status === "confirmed" ? (
            <ReverseReceptionAction
              reception={reception}
              ingredients={ingredients}
              onReversed={() => {
                invalidate()
                setOpen(false)
              }}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default ReceptionDetailDialog
