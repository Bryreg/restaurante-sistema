import { useState } from "react";

import type { OrderOut, TipInfoOut, TotalsOut } from "@/api/orders";
import type { PaymentOut, PaymentTipIn } from "@/api/payments";
import { formatCOP } from "@/lib/money";

import type { InitialSplit } from "./PaymentSplitsForm";
import { PaymentSplitsForm } from "./PaymentSplitsForm";
import { TipQuestion } from "./TipQuestion";

export interface PaymentTarget {
  /** `undefined` = se cobra la comanda entera; con valor, esa sub-cuenta. */
  subAccountId?: number;
  totals: TotalsOut;
  tipInfo: TipInfoOut | null | undefined;
}

export interface PaymentTargetPanelProps {
  orderId: number;
  expectedVersion?: number;
  target: PaymentTarget;
  tipsEnabled: boolean;
  initialSplits?: InitialSplit[];
  onPaid: (result: PaymentOut) => void;
  onStale: (order: OrderOut) => void;
  onAlreadyPaid: () => void;
}

/**
 * Junta la pregunta de propina (cuando aplica) con la tabla de pagos para UN
 * blanco de cobro — la comanda entera o una sub-cuenta de la división por
 * ítems. Con `pos.tips` encendida y el blanco tiene `tipInfo`, no se muestra
 * la tabla de pagos hasta responder la propina (el servidor exige
 * `tip.asked` — CONTRATO-INTERNO-1b-1.md §2.4). Con `pos.tips` apagada no
 * hay pregunta (checklist del pedido).
 *
 * **A-10** (`features/fase-1b-venta/outputs-1b-1/auditor-venta.md §3`;
 * `docs/ESTADO.md § Dónde retomar` punto 6): antes de este pedido acá se
 * armaba `const totalDue = (target.totals.total ?? 0) + (tip?.amount ?? 0)`
 * y se pintaba como «Total a cobrar» — el único número de plata que
 * calculaba el cliente, con un `?? 0` que convertía un `total` ausente en
 * «$0» en pantalla. Ahora la venta y la propina se muestran como dos
 * líneas SEPARADAS, cada una pintada tal cual llega (nunca sumadas por el
 * cliente); si `target.totals.total` no llegó, se dice explícitamente en
 * vez de ofrecer cobrar sobre un total inventado.
 *
 * GAP declarado (ver entregable): `PaymentOut.amount_due` (venta + propina
 * ya sumadas por el servidor) existe recién en la respuesta de `POST
 * /orders/{id}/payments` — DESPUÉS de cobrar (`PaymentTargetPanel.tsx`
 * pinta ese campo indirectamente al navegar a `DocumentPage`) — no en
 * `OrderOut.totals`/`SubAccountOut.totals` (ANTES de cobrar, que es lo que
 * esta pantalla necesitaría para pintar un monto ya sumado sin derivarlo).
 * Ver `features/fase-1b-venta/outputs-1b-2/backend-fiscal.md § 7, punto 9:
 * el propio backend declara que ese campo pre-pago necesita a alguien con
 * `app/orders/schemas.py` en su territorio, que ningún agente de este
 * pedido tuvo asignado. Mostrar dos líneas sin sumarlas es la alternativa
 * que el propio hallazgo A-10 dejó declarada mientras ese campo no exista.
 */
export function PaymentTargetPanel({
  orderId,
  expectedVersion,
  target,
  tipsEnabled,
  initialSplits,
  onPaid,
  onStale,
  onAlreadyPaid,
}: PaymentTargetPanelProps): React.JSX.Element {
  const [tip, setTip] = useState<PaymentTipIn | null>(null);

  const showTipQuestion = tipsEnabled && target.tipInfo != null;
  const tipResolved = !showTipQuestion || tip !== null;
  const saleTotal = target.totals.total;

  return (
    <div className="space-y-4">
      {showTipQuestion && target.tipInfo ? (
        <TipQuestion tipInfo={target.tipInfo} value={tip} onChange={setTip} />
      ) : null}

      {!tipResolved ? (
        <p className="text-sm text-muted-foreground">Respondé la propina para continuar con el cobro.</p>
      ) : saleTotal == null ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo calcular el total de esta cuenta. Volvé a cargarla antes de cobrar.
        </p>
      ) : (
        <>
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <div className="flex justify-between">
              <span>Venta</span>
              <span className="tabular-nums font-medium">{formatCOP(saleTotal)}</span>
            </div>
            {tip && tip.amount > 0 ? (
              <div className="flex justify-between">
                <span>Propina</span>
                <span className="tabular-nums font-medium">{formatCOP(tip.amount)}</span>
              </div>
            ) : null}
          </div>
          <PaymentSplitsForm
            orderId={orderId}
            expectedVersion={expectedVersion}
            subAccountId={target.subAccountId}
            totalDue={saleTotal + (tip?.amount ?? 0)}
            tip={tipsEnabled ? tip ?? undefined : undefined}
            initialSplits={initialSplits}
            onPaid={onPaid}
            onStale={onStale}
            onAlreadyPaid={onAlreadyPaid}
          />
        </>
      )}
    </div>
  );
}
