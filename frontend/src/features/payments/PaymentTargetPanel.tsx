import { useState } from "react";
import { createPortal } from "react-dom";

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
  /**
   * Lo que va entre la propina ya respondida y los pagos. `CheckoutPage` pone
   * acá «Partes iguales»: la propina se pregunta ANTES de dividir, para que
   * el servidor reparta venta + propina y ninguna parte quede en «faltan $X».
   */
  beforePayments?: (tip: PaymentTipIn | null) => React.ReactNode;
  /** Cambia cuando la tabla de pagos se tiene que volver a sembrar (p. ej. partes iguales nuevas) sin perder la propina. */
  splitsKey?: string;
  /**
   * Dónde va la cuenta —la propina, lo que va entre la propina y los pagos
   * (`beforePayments`) y el libro «Consumo / Propina (no es venta) / Total»
   * con doble raya—: la columna izquierda de 440 px del cobro (handoff
   * `PosCobro`). Sin él, arriba de los pagos.
   */
  cuentaSlot?: HTMLElement | null;
  /** El rótulo sobre el total grande («Total a cobrar», «Parte 2 de 3 · a cobrar»). */
  rotuloTotal?: string;
}

/**
 * Junta la pregunta de propina (cuando aplica) con la tabla de pagos para UN
 * blanco de cobro — la comanda entera o una sub-cuenta de la división por
 * ítems. Con `pos.tips` encendida y el blanco tiene `tipInfo`, no se puede
 * cobrar hasta responder la propina (el servidor exige `tip.asked` —
 * CONTRATO-INTERNO-1b-1.md §2.4): la tabla de pagos se ve (el handoff la
 * quiere siempre a la vista) pero «Cobrar» queda bloqueado y dice por qué.
 * Con `pos.tips` apagada no hay pregunta (checklist del pedido).
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
  beforePayments,
  splitsKey,
  cuentaSlot,
  rotuloTotal,
}: PaymentTargetPanelProps): React.JSX.Element {
  const [tip, setTip] = useState<PaymentTipIn | null>(null);

  const showTipQuestion = tipsEnabled && target.tipInfo != null;
  const tipResolved = !showTipQuestion || tip !== null;
  const saleTotal = target.totals.total;

  // La cuenta (propina y libro con doble raya) va en la columna de la
  // cuenta —izquierda, 440 px— cuando la pantalla le da un lugar; si no,
  // arriba de los pagos.
  const cuenta = (
    <div className="flex flex-col gap-3">
      {showTipQuestion && target.tipInfo ? (
        <TipQuestion tipInfo={target.tipInfo} value={tip} onChange={setTip} />
      ) : null}
      {tipResolved && saleTotal != null ? beforePayments?.(tip) : null}
      {saleTotal != null ? (
        <dl className="flex flex-col border-t-[3px] border-double border-foreground/60 pt-2">
          <div className="flex justify-between text-[15px] text-muted-foreground">
            <dt>Consumo</dt>
            <dd className="tabular-nums">{formatCOP(saleTotal)}</dd>
          </div>
          {showTipQuestion ? (
            <div className="flex justify-between text-[15px] text-muted-foreground">
              <dt>Propina (no es venta)</dt>
              <dd className="tabular-nums">{tip ? formatCOP(tip.amount) : "—"}</dd>
            </div>
          ) : null}
          <div className="flex justify-between pt-1 text-[20px] font-extrabold">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatCOP(saleTotal + (tip?.amount ?? 0))}</dd>
          </div>
        </dl>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      {cuentaSlot ? createPortal(cuenta, cuentaSlot) : cuenta}

      {saleTotal == null ? (
        <p role="alert" className="text-sm text-destructive">
          No se pudo calcular el total de esta cuenta. Volvé a cargarla antes de cobrar.
        </p>
      ) : (
        <PaymentSplitsForm
          key={splitsKey}
          orderId={orderId}
          expectedVersion={expectedVersion}
          subAccountId={target.subAccountId}
          totalDue={saleTotal + (tip?.amount ?? 0)}
          rotuloTotal={rotuloTotal}
          bloqueo={tipResolved ? null : "Respondé la propina para continuar con el cobro."}
          tip={tipsEnabled ? tip ?? undefined : undefined}
          initialSplits={initialSplits}
          onPaid={onPaid}
          onStale={onStale}
          onAlreadyPaid={onAlreadyPaid}
        />
      )}
    </div>
  );
}
