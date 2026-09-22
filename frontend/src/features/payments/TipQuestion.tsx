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
  const [customAmount, setCustomAmount] = useState<number | null>(tipInfo.suggested_amount ?? 0);

  const suggestedPct = tipInfo.suggested_pct ?? 0;
  const suggestedAmount = tipInfo.suggested_amount ?? 0;

  function accept() {
    setModifying(false);
    onChange({ asked: true, accepted: true, modified: false, amount: suggestedAmount });
  }

  function decline() {
    setModifying(false);
    onChange({ asked: true, accepted: false, modified: false, amount: 0 });
  }

  function confirmCustom() {
    const amount = customAmount ?? 0;
    onChange({ asked: true, accepted: amount > 0, modified: true, amount });
    setModifying(false);
  }

  // Cuál opción está marcada. `value === null` es «todavía no se preguntó»,
  // que NO es lo mismo que «dijo que no»: mientras esté sin responder el
  // cobro no sigue, y ninguna opción se dibuja elegida.
  const elegida = value === null ? null : value.modified ? "otro" : value.accepted ? "sugerida" : "no";

  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-bold">Propina</h2>
        <span className="ml-auto text-xs text-muted-foreground">Hay que preguntarla</span>
      </div>

      {/* Las opciones de `m2b`, con una diferencia declarada: la maqueta
          ofrece «5 %» y «10 %» fijos, y acá el único porcentaje es el que
          manda el servidor (`suggested_pct` / `suggested_amount`, ya con su
          tope del 10 %). Un botón de «5 %» obligaría a la pantalla a sacar
          el 5 % de la base — plata calculada en el cliente, que es lo que el
          contrato prohíbe. «Otro valor» sigue existiendo: ahí el monto lo
          dice una persona, no lo deriva el POS. */}
      {!modifying ? (
        <div role="group" aria-label="Propina voluntaria" className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant={elegida === "no" ? "default" : "outline"}
            aria-pressed={elegida === "no"}
            className="h-11"
            onClick={decline}
          >
            No incluir
          </Button>
          <Button
            type="button"
            variant={elegida === "sugerida" ? "default" : "outline"}
            aria-pressed={elegida === "sugerida"}
            className="h-11"
            onClick={accept}
          >
            {suggestedPct}% · {formatCOP(suggestedAmount)}
          </Button>
          <Button
            type="button"
            variant={elegida === "otro" ? "default" : "outline"}
            aria-pressed={elegida === "otro"}
            className="h-11"
            onClick={() => setModifying(true)}
          >
            Otro valor
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
        <div className="flex items-baseline gap-3 border-t pt-2.5" role="status">
          <span>Propina</span>
          <b className="ml-auto text-lg tabular-nums">{formatCOP(value.amount)}</b>
        </div>
      ) : null}

      {/* La nota de la maqueta, palabra por palabra. Las tres cosas que dice
          son las tres que se discuten: que es voluntaria, que se pregunta
          siempre, y que va aparte de la venta (Ley 1935 de 2018). */}
      <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
        La propina es <b className="text-foreground">voluntaria</b>. Se pregunta siempre y el cliente puede decir que
        no. Va aparte de la venta: no paga impuesto al consumo y se reparte en nómina.
      </p>
    </section>
  );
}
