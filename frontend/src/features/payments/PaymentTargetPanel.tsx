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
  const totalDue = (target.totals.total ?? 0) + (tip?.amount ?? 0);

  return (
    <div className="space-y-4">
      {showTipQuestion && target.tipInfo ? (
        <TipQuestion tipInfo={target.tipInfo} value={tip} onChange={setTip} />
      ) : null}

      {!tipResolved ? (
        <p className="text-sm text-muted-foreground">Respondé la propina para continuar con el cobro.</p>
      ) : (
        <>
          <p className="text-sm font-medium">Total a cobrar: {formatCOP(totalDue)}</p>
          <PaymentSplitsForm
            orderId={orderId}
            expectedVersion={expectedVersion}
            subAccountId={target.subAccountId}
            totalDue={totalDue}
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
