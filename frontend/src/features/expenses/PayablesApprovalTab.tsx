/**
 * Admin → Obligaciones y gastos → Cuentas por pagar (D-2, spec.md § 1 y § T2
 * "expenses"): `GET /admin/payables/{id}` gana `invoice_total` e
 * `invoice_discrepancy`; `POST /admin/payables/{id}/approve` corta con
 * `409 INVOICE_DISCREPANCY` cuando hay diferencia y no viene
 * `confirm_discrepancy: true` — el mismo patrón que `confirm_price` ya usa
 * en `ReceptionForm.tsx` (territorio de `features/purchases`, copiado acá,
 * nunca importado ni reescrito).
 *
 * Búsqueda por id, no un listado: `GET /admin/payables` (la lista) no forma
 * parte del contrato de esta fase — sólo lo gana el detalle por id (spec.md
 * § 2, tabla "T2 — expenses"). Ver gap en el entregable: idealmente
 * `features/purchases/PayablesTab.tsx` (territorio ajeno) enlaza acá cuando
 * detecta una diferencia, en vez de que el administrador tenga que teclear
 * el id a mano.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"

import { ApiError } from "@/api/client"
import { approvePayable, getPayableDetail, type PayableDetailOut } from "@/api/expenses"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { PinPad } from "@/components/PinPad"
import { formatBusinessDate } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCOP } from "@/lib/money"

import { payableStatusLabel } from "./lib"

function ApproveWithDiscrepancy({ payable, onApproved }: { payable: PayableDetailOut; onApproved: () => void }): React.JSX.Element {
  const [confirmDiscrepancy, setConfirmDiscrepancy] = useState(false)

  const mutation = useMutation({
    mutationFn: (pin: string) => approvePayable(payable.id, { authorizer_pin: pin, confirm_discrepancy: confirmDiscrepancy }),
    onSuccess: onApproved,
    onError: (err) => {
      if (err instanceof ApiError && err.code === "INVOICE_DISCREPANCY") {
        setConfirmDiscrepancy(true)
      }
    },
  })

  const isDiscrepancy = mutation.isError && mutation.error instanceof ApiError && mutation.error.code === "INVOICE_DISCREPANCY"
  const otherError = mutation.isError && !isDiscrepancy ? errorMessage(mutation.error) : null

  return (
    <div className="space-y-3 rounded-md border p-4">
      {isDiscrepancy || confirmDiscrepancy ? (
        <div role="alert" className="space-y-2 rounded-md border border-destructive/50 bg-destructive/5 p-3">
          <p className="text-sm font-semibold text-destructive">La factura no coincide con lo calculado</p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-muted-foreground">Lo que dice el papel</p>
              <p className="tabular-nums font-semibold">{formatCOP(payable.invoice_total)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Lo calculado (línea por línea)</p>
              <p className="tabular-nums font-semibold">{formatCOP(payable.amount)}</p>
            </div>
          </div>
          <p className="text-sm">
            Diferencia: <span className="font-semibold tabular-nums">{formatCOP(payable.invoice_discrepancy)}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            El sistema no ajusta ninguna de las dos cifras: se pagan las dos por separado (al proveedor, contra el
            papel; el inventario, contra el cálculo). Confirmá sólo si revisaste la diferencia.
          </p>
        </div>
      ) : null}
      {otherError ? (
        <p role="alert" className="text-sm text-destructive">
          {otherError}
        </p>
      ) : null}
      <PinPad
        length={4}
        label={confirmDiscrepancy ? "PIN de administrador para confirmar la diferencia" : "PIN de administrador para aprobar"}
        disabled={mutation.isPending}
        onSubmit={(pin) => mutation.mutate(pin)}
      />
    </div>
  )
}

export function PayablesApprovalTab({ storeId: _storeId }: { storeId: number }): React.JSX.Element {
  const [idInput, setIdInput] = useState("")
  const [payableId, setPayableId] = useState<number | null>(null)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: ["expenses", "payable-detail", payableId],
    queryFn: () => getPayableDetail(payableId as number),
    enabled: payableId !== null,
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="payable-id-lookup">Buscar cuenta por pagar por id</Label>
          <Input
            id="payable-id-lookup"
            className="h-11 w-40"
            inputMode="numeric"
            value={idInput}
            onChange={(event) => setIdInput(event.target.value.replace(/\D/g, ""))}
          />
        </div>
        <Button type="button" disabled={idInput.trim() === ""} onClick={() => setPayableId(Number(idInput))}>
          Buscar
        </Button>
      </div>

      {payableId === null ? (
        <EmptyState title="Ingresá el id de una cuenta por pagar para revisar su factura" />
      ) : query.isLoading ? (
        <Cargando texto="Cargando la cuenta por pagar…" />
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudo cargar esa cuenta por pagar" description={errorMessage(query.error)} action={{ label: "Reintentar", onClick: () => void query.refetch() }} />
      ) : query.data ? (
        <div className="space-y-3 rounded-lg border p-4">
          <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <p className="text-muted-foreground">Estado</p>
              <Badge variant={query.data.status === "approved" ? "secondary" : "outline"}>{payableStatusLabel(query.data.status)}</Badge>
            </div>
            <div>
              <p className="text-muted-foreground">Calculado (línea por línea)</p>
              <p className="tabular-nums">{formatCOP(query.data.amount)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Factura del proveedor</p>
              <p className="tabular-nums">{query.data.invoice_total === null ? "Sin factura" : formatCOP(query.data.invoice_total)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Vencimiento</p>
              <p>{formatBusinessDate(query.data.due_date)}</p>
            </div>
          </div>
          {query.data.invoice_discrepancy !== null && query.data.invoice_discrepancy !== 0 ? (
            <p className="text-sm text-warning">
              Diferencia con el papel: {formatCOP(query.data.invoice_discrepancy)}
            </p>
          ) : null}
          {query.data.status === "pending_review" ? (
            <ApproveWithDiscrepancy
              payable={query.data}
              onApproved={() => void queryClient.invalidateQueries({ queryKey: ["expenses", "payable-detail", payableId] })}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Esta cuenta no está pendiente de revisión.</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default PayablesApprovalTab
