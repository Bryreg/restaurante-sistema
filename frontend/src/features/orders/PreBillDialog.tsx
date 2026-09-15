import { Printer } from "lucide-react"

import type { PreBillOut } from "@/api/orders"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatCOP } from "@/lib/money"

export interface PreBillDialogProps {
  preBill: PreBillOut | null
  onOpenChange: (open: boolean) => void
  onReprint: () => void
  pending?: boolean
}

/**
 * Precuenta (`pos.pre_bill`): documento NO fiscal — muestra la leyenda tal
 * cual llega del servidor y cuenta impresiones (`bill_print_count`). Todo
 * número acá viene ya calculado en `PreBillOut`; el frontend sólo lo pinta
 * (AGENTS.md § "una sola matemática").
 */
export function PreBillDialog({ preBill, onOpenChange, onReprint, pending = false }: PreBillDialogProps): React.JSX.Element {
  return (
    <Dialog open={preBill !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Precuenta</DialogTitle>
        </DialogHeader>
        {preBill ? (
          <div className="space-y-4">
            <p role="note" className="rounded-md border border-dashed p-2 text-center text-sm font-medium">
              {preBill.legend}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Ítem</TableHead>
                    <TableHead className="text-right">Cant.</TableHead>
                    <TableHead className="text-right">Neto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(preBill.lines ?? []).map((line, index) => (
                    <TableRow key={index}>
                      <TableCell>{line.description}</TableCell>
                      <TableCell className="text-right tabular-nums">{line.qty}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCOP(line.net)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular-nums">{formatCOP(preBill.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Descuentos</dt>
                <dd className="tabular-nums">{formatCOP(preBill.discount_total)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Impuesto</dt>
                <dd className="tabular-nums">{formatCOP(preBill.tax_total)}</dd>
              </div>
              <div className="flex justify-between text-base font-semibold">
                <dt>Total</dt>
                <dd className="tabular-nums">{formatCOP(preBill.total)}</dd>
              </div>
              {preBill.tip ? (
                <div className="flex justify-between text-muted-foreground">
                  <dt>Propina sugerida ({preBill.tip.suggested_pct}%)</dt>
                  <dd className="tabular-nums">{formatCOP(preBill.tip.suggested_amount)}</dd>
                </div>
              ) : null}
            </dl>
            <p className="text-xs text-muted-foreground">Impresiones: {preBill.bill_print_count ?? 1}</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" className="h-11" disabled={pending} onClick={onReprint}>
            <Printer className="size-4" aria-hidden="true" />
            {pending ? "Imprimiendo…" : "Volver a imprimir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default PreBillDialog
