import { useState } from "react";

import type { TipInfoOut } from "@/api/orders";
import type { PaymentTipIn } from "@/api/payments";
import { MoneyInput } from "@/components/MoneyInput";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatCOP } from "@/lib/money";

export interface TipQuestionProps {
  tipInfo: TipInfoOut;
  value: PaymentTipIn | null;
  onChange: (tip: PaymentTipIn) => void;
}

/**
 * Pregunta de propina (SPEC-NEGOCIO §6.2 y §9.1; CONTRATO-INTERNO-1b-1.md
 * §2.4): "¿Desea incluir servicio voluntario del X %?", con el sugerido que
 * manda el servidor (`tip.suggested_amount`, base = subtotal neto de
 * descuentos sin impuesto — el servidor también valida que la configuración
 * de sugerido no supere el 10 %, esta pantalla sólo la muestra). Registra
 * `asked/accepted/modified/amount`; nunca deriva ni valida el monto.
 */
export function TipQuestion({ tipInfo, value, onChange }: TipQuestionProps): React.JSX.Element {
  const [modifying, setModifying] = useState(false);
  // Ya respondida, la pregunta se pliega a un renglón: en la tablet vertical
  // el espacio es para lo recibido y el PIN, no para una pregunta contestada.
  const [reopened, setReopened] = useState(false);
  const [customAmount, setCustomAmount] = useState<number | null>(tipInfo.suggested_amount ?? 0);

  const suggestedPct = tipInfo.suggested_pct ?? 0;
  const suggestedAmount = tipInfo.suggested_amount ?? 0;

  function accept() {
    setModifying(false);
    setReopened(false);
    onChange({ asked: true, accepted: true, modified: false, amount: suggestedAmount });
  }

  function decline() {
    setModifying(false);
    setReopened(false);
    onChange({ asked: true, accepted: false, modified: false, amount: 0 });
  }

  function confirmCustom() {
    const amount = customAmount ?? 0;
    onChange({ asked: true, accepted: amount > 0, modified: true, amount });
    setModifying(false);
    setReopened(false);
  }

  if (value && !reopened) {
    return (
      <div className="flex min-h-11 items-center justify-between gap-2 rounded-md border px-3 py-1">
        <p className="text-sm" role="status">
          {value.accepted ? `Propina: ${formatCOP(value.amount)}` : "Sin propina."}
        </p>
        <Button type="button" variant="ghost" className="h-11" onClick={() => setReopened(true)}>
          Cambiar propina
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">¿Desea incluir servicio voluntario del {suggestedPct}%?</p>
      <p className="text-sm text-muted-foreground">Sugerido: {formatCOP(suggestedAmount)}</p>

      {!modifying ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" className="h-11" onClick={accept}>
            Sí, {formatCOP(suggestedAmount)}
          </Button>
          <Button type="button" variant="outline" className="h-11" onClick={() => setModifying(true)}>
            Modificar monto
          </Button>
          <Button type="button" variant="ghost" className="h-11" onClick={decline}>
            No
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="tip-custom-amount">Monto de propina</Label>
            <MoneyInput id="tip-custom-amount" value={customAmount} onChange={setCustomAmount} />
          </div>
          <Button type="button" className="h-11" onClick={confirmCustom}>
            Confirmar
          </Button>
          <Button type="button" variant="ghost" className="h-11" onClick={() => setModifying(false)}>
            Cancelar
          </Button>
        </div>
      )}

      {value ? (
        <p className="text-sm" role="status">
          {value.accepted ? `Propina: ${formatCOP(value.amount)}` : "Sin propina."}
        </p>
      ) : null}
    </div>
  );
}
