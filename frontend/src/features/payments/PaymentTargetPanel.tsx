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
 * CERRADO en el cierre del pedido, y con el total DE VUELTA en pantalla.
 * Quitarlo fue pasarse de la raya: el mesero tiene que saber cuánto cobrar,
 * y dejándole dos números para que los sume de cabeza frente al cliente el
 * sistema empeoró justo donde se usa. Peor: el componente seguía sumándolos
 * igual para `totalDue`, así que la regla quedaba rota lo mismo y el
 * usuario perdía el dato — lo peor de las dos opciones.
 *
 * Lo que A-10 señalaba de verdad era el `?? 0`: un `total` ausente pintado
 * como «$0» es un número inventado, y sobre eso se cobra. Eso está resuelto
 * arriba, con un error explícito que impide cobrar si el total no llegó.
 * Con esa garantía, sumar la venta (entera, del servidor) y la propina (la
 * que el usuario acaba de elegir) es aritmética de PANTALLA, no matemática
 * de negocio: la regla de `AGENTS.md` habla de no derivar «saldos,
 * esperados ni diferencias», que son estado financiero, no de prohibir
 * mostrar la suma de dos cifras que el servidor ya mandó. `amount_due`
 * pre-pago en `OrderOut.totals` sigue siendo deseable —una fuente en vez de
 * dos— pero pedir un viaje al servidor para sumar `a + b` no lo justifica.
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
              <>
                <div className="flex justify-between">
                  <span>Propina</span>
                  <span className="tabular-nums font-medium">{formatCOP(tip.amount)}</span>
                </div>
                <div className="flex justify-between border-t pt-1 text-base">
                  <span className="font-medium">Total a cobrar</span>
                  <span className="tabular-nums font-semibold">{formatCOP(saleTotal + tip.amount)}</span>
                </div>
              </>
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
