import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import type { IngredientOut } from "@/api/inventory"
import { reverseReception, type ReceptionOut, type SupplierOut } from "@/api/purchases"
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatBusinessDate, formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP, formatCOPDecimal } from "@/lib/money"

import { RECEPTION_STATUS_LABEL, supplierName } from "./lib"

function ingredientName(ingredients: IngredientOut[], id: number): string {
  return ingredients.find((i) => i.id === id)?.name ?? `Insumo #${id}`
}

/**
 * Eliminar una recepción muestra QUÉ se va a revertir (sus propias líneas,
 * ya traídas — nada nuevo se calcula acá) ANTES de pedir el PIN, y explica
 * en castellano por qué no se puede si el backend contesta
 * `409 LOT_CONSUMED` o `409 PAYABLE_HAS_PAYMENTS` (spec.md § Receptions).
 * Nada se borra de fila: la reversa es un movimiento con causa propia.
 */
function ReverseReceptionAction({
  reception,
  onReversed,
}: {
  reception: ReceptionOut
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
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) mutation.reset()
      }}
    >
      <AlertDialogTrigger render={<Button type="button" variant="destructive" />}>Eliminar recepción</AlertDialogTrigger>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>Esto es lo que se va a revertir</AlertDialogTitle>
          <AlertDialogDescription>
            No se borra ninguna fila: queda un movimiento de reversa por cada línea, y la cuenta por pagar asociada se
            cancela si no tiene pagos vivos.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-3 text-sm">
          {reception.lines.map((line) => (
            <li key={line.id} className="flex justify-between gap-2">
              <span>Insumo #{line.ingredient_id}</span>
              <span className="tabular-nums text-muted-foreground">
                {line.qty_received} recibido{line.lot_code ? ` · lote ${line.lot_code}` : ""}
              </span>
            </li>
          ))}
        </ul>
        {reception.payable_id !== null ? (
          <p className="text-sm text-muted-foreground">
            Esta recepción tiene una cuenta por pagar asociada (#{reception.payable_id}). Si ya tiene pagos vivos, la
            reversa se rechaza — hay que anular esos pagos primero.
          </p>
        ) : null}
        <div className="space-y-1">
          <Label htmlFor="rec-reverse-pin">PIN de administrador</Label>
          <Input
            id="rec-reverse-pin"
            type="password"
            inputMode="numeric"
            className="h-11"
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
            variant="destructive"
            disabled={pin.trim() === "" || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Eliminar recepción
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>Ver</DialogTrigger>
      <DialogContent className="max-w-3xl">
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

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Insumo</TableHead>
                  <TableHead>Recibido</TableHead>
                  <TableHead>Facturado</TableHead>
                  <TableHead>Precio compra</TableHead>
                  <TableHead>Costo final</TableHead>
                  <TableHead>IVA/INC</TableHead>
                  <TableHead>Lote</TableHead>
                  <TableHead>Vence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reception.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell className="font-medium">{ingredientName(ingredients, line.ingredient_id)}</TableCell>
                    <TableCell className="tabular-nums">{line.qty_received}</TableCell>
                    <TableCell className="tabular-nums">{line.qty_invoiced}</TableCell>
                    <TableCell className="tabular-nums">{formatCOPDecimal(line.purchase_unit_price)}</TableCell>
                    <TableCell className="tabular-nums">{formatCOPDecimal(line.final_unit_cost)}</TableCell>
                    <TableCell className="tabular-nums">
                      {line.tax_rate}% · {formatCOP(line.tax_amount)}
                    </TableCell>
                    <TableCell>{line.lot_code ?? "—"}</TableCell>
                    <TableCell>{line.expires_at ? formatBusinessDate(line.expires_at) : "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {reception.status === "confirmed" ? (
            <ReverseReceptionAction
              reception={reception}
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
