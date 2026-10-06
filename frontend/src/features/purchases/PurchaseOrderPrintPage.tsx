import { useQuery } from "@tanstack/react-query"
import { Printer } from "lucide-react"
import { useState } from "react"
import { useSearchParams } from "react-router-dom"

import { getPurchaseOrder } from "@/api/purchases"
import { Cargando } from "@/components/Cargando"
import { EmptyState } from "@/components/EmptyState"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { formatInstant } from "@/lib/businessDate"
import { errorMessage } from "@/lib/errors"
import { formatCantidad, formatFechaCorta } from "@/lib/format"
import { formatCOP, formatCOPDecimal } from "@/lib/money"

import { PURCHASE_ORDER_STATUS_LABEL } from "./lib"

/**
 * **La orden de compra para imprimir o mandar al proveedor**
 * (`/imprimir/orden-compra?id=ID`): hoja A4 sin el marco del panel, como la
 * ficha técnica. «Descargar PDF / imprimir» abre el diálogo del navegador,
 * que la guarda como PDF para mandarla por WhatsApp o correo. Los precios
 * esperados son opcionales en la hoja: el dueño decide si el proveedor los
 * ve. Nada se calcula acá: cantidades y total llegan del servidor.
 */
export function PurchaseOrderPrintPage(): React.JSX.Element {
  const [params] = useSearchParams()
  const orderId = Number(params.get("id")) || null
  const [withPrices, setWithPrices] = useState(params.get("precios") === "1")

  const query = useQuery({
    queryKey: ["purchases", "orders", "print", orderId],
    queryFn: () => getPurchaseOrder(orderId as number),
    enabled: orderId !== null,
  })

  if (orderId === null) {
    return <EmptyState reason="dependency" title="Falta qué orden imprimir" description="La dirección no nombra una orden de compra." />
  }
  if (query.isLoading) return <Cargando texto="Armando la orden…" className="p-6" />
  if (query.isError || !query.data) {
    return <EmptyState reason="error" title="No se pudo armar la orden" description={errorMessage(query.error)} />
  }
  const o = query.data
  return (
    <div className="min-h-screen bg-neutral-100 py-6 print:bg-white print:py-0">
      <div className="mx-auto mb-4 flex max-w-[210mm] flex-wrap items-center gap-3 px-4 print:hidden">
        <Button type="button" onClick={() => window.print()} className="gap-1.5">
          <Printer className="size-4" aria-hidden="true" />
          Descargar PDF / imprimir
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={withPrices} onCheckedChange={(c) => setWithPrices(c === true)} />
          Mostrar precios esperados
        </label>
        <span className="text-xs text-muted-foreground">En el diálogo, elegí «Guardar como PDF» para mandarla al proveedor.</span>
      </div>

      <article className="mx-auto max-w-[210mm] bg-white px-10 py-8 text-neutral-900 shadow-sm print:max-w-none print:px-0 print:py-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-neutral-900 pb-3">
          <div>
            <p className="text-[11px] tracking-[0.14em] text-neutral-500 uppercase">Orden de compra</p>
            <h1 className="mt-1 text-[28px] leading-tight font-bold">#{o.number}</h1>
            <p className="mt-1 text-sm">
              {o.store_name} · {formatFechaCorta(o.business_date)}
              {o.status !== "draft" && o.status !== "sent" ? ` · ${PURCHASE_ORDER_STATUS_LABEL[o.status]}` : ""}
            </p>
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">{o.supplier_name}</p>
            {o.supplier_nit ? <p>NIT {o.supplier_nit}</p> : null}
            {o.supplier_contact_name ? <p>{o.supplier_contact_name}</p> : null}
            {o.supplier_contact_phone ? <p>{o.supplier_contact_phone}</p> : null}
          </div>
        </header>

        {o.expected_date ? (
          <p className="mt-3 text-sm">
            <b>Entregar el:</b> {formatFechaCorta(o.expected_date)}
          </p>
        ) : null}

        <table className="mt-5 w-full text-[15px]">
          <thead className="border-b border-neutral-400 text-left text-[12px] tracking-[0.08em] uppercase">
            <tr>
              <th className="py-1.5 pr-2 font-semibold">Insumo</th>
              <th className="py-1.5 pr-2 text-right font-semibold">Cantidad</th>
              {withPrices ? <th className="py-1.5 text-right font-semibold">Precio unitario</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-300">
            {o.lines.map((ln) => (
              <tr key={ln.id}>
                <td className="py-1.5 pr-2">{ln.ingredient_name}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums whitespace-nowrap">{formatCantidad(ln.quantity, ln.purchase_unit)}</td>
                {withPrices ? (
                  <td className="py-1.5 text-right tabular-nums">
                    {ln.expected_unit_price === null ? "—" : formatCOPDecimal(ln.expected_unit_price)}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>

        {withPrices ? (
          <p className="mt-3 text-right text-sm">
            Total esperado:{" "}
            <b className="tabular-nums">{o.expected_total === null ? (o.expected_total_reason ?? "sin total") : formatCOP(o.expected_total)}</b>
          </p>
        ) : null}

        {o.notes ? (
          <section className="mt-5 break-inside-avoid">
            <h2 className="text-[13px] font-bold tracking-[0.12em] uppercase">Notas</h2>
            <p className="mt-1 text-[15px] whitespace-pre-line">{o.notes}</p>
          </section>
        ) : null}

        <footer className="mt-8 border-t border-neutral-300 pt-2 text-[11px] text-neutral-500">
          Pedida por {o.created_by_employee_name}
          {o.sent_at ? ` · enviada el ${formatInstant(o.sent_at)}` : ""}
        </footer>
      </article>
    </div>
  )
}

export default PurchaseOrderPrintPage
