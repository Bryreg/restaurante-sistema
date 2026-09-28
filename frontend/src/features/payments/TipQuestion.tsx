import { useState } from "react";

import type { TipInfoOut } from "@/api/orders";
import type { PaymentTipIn } from "@/api/payments";
import { MoneyInput } from "@/components/MoneyInput";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatCOP } from "@/lib/money";
import { cn } from "@/lib/utils";

export interface TipQuestionProps {
  tipInfo: TipInfoOut;
  value: PaymentTipIn | null;
  onChange: (tip: PaymentTipIn) => void;
}

/** Opción de propina: 64 px, borde de 2 px; la elegida en `primary` sobre `accent`. */
function opcionClass(elegida: boolean): string {
  return cn(
    "flex h-[64px] min-w-0 flex-col items-center justify-center rounded-lg border-2 px-2 transition-colors",
    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
    elegida ? "border-primary bg-accent" : "border-border bg-card hover:bg-muted",
  );
}

/**
 * Pregunta de propina (SPEC-NEGOCIO §6.2 y §9.1; CONTRATO-INTERNO-1b-1.md
 * §2.4), como la dibuja el handoff (`PosCobro`): «Propina voluntaria · la
 * decide el cliente» y tres opciones de 64 px — «10 % sugerida» con el
 * sugerido que manda el servidor (`tip.suggested_amount`, base = subtotal
 * neto de descuentos sin impuesto; el servidor también valida que no supere
 * el 10 %), «Otra» (el monto a mano) y «Sin propina». Registra
 * `asked/accepted/modified/amount`; nunca deriva ni valida el monto.
 */
export function TipQuestion({ tipInfo, value, onChange }: TipQuestionProps): React.JSX.Element {
  const [modifying, setModifying] = useState(false);
  const [customAmount, setCustomAmount] = useState<number | null>(tipInfo.suggested_amount ?? 0);

  const suggestedPct = tipInfo.suggested_pct ?? 0;
  const suggestedAmount = tipInfo.suggested_amount ?? 0;

  const eligioSugerida = value !== null && value.accepted && !value.modified;
  const eligioOtra = modifying || (value !== null && value.modified && value.accepted);
  const eligioNinguna = !modifying && value !== null && !value.accepted;

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

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[16px] font-bold">
        Propina voluntaria <span className="font-medium text-muted-foreground">· la decide el cliente</span>
      </p>
      <p className="text-[13px] text-muted-foreground">¿Desea incluir servicio voluntario del {suggestedPct}%?</p>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="Propina">
        <button type="button" aria-pressed={eligioSugerida} className={opcionClass(eligioSugerida)} onClick={accept}>
          <b className="text-[16px]">{suggestedPct} % sugerida</b>{" "}
          <span className="text-[14px] text-muted-foreground tabular-nums">{formatCOP(suggestedAmount)}</span>
        </button>
        <button
          type="button"
          aria-pressed={eligioOtra}
          className={opcionClass(eligioOtra)}
          onClick={() => setModifying(true)}
        >
          <b className="text-[16px]">Otra</b>{" "}
          <span className="text-[14px] text-muted-foreground tabular-nums">
            {value?.modified && value.accepted ? formatCOP(value.amount) : "—"}
          </span>
        </button>
        <button type="button" aria-pressed={eligioNinguna} className={opcionClass(eligioNinguna)} onClick={decline}>
          <b className="text-[16px]">Sin propina</b>{" "}
          <span className="text-[14px] text-muted-foreground tabular-nums">{formatCOP(0)}</span>
        </button>
      </div>

      {modifying ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="tip-custom-amount">Monto de propina</Label>
            <MoneyInput id="tip-custom-amount" value={customAmount} onChange={setCustomAmount} />
          </div>
          <Button type="button" className="h-[56px] px-4 text-[16px]" onClick={confirmCustom}>
            Confirmar
          </Button>
          <Button type="button" variant="ghost" className="h-[56px] px-3 text-[16px]" onClick={() => setModifying(false)}>
            Cancelar
          </Button>
        </div>
      ) : null}

      {value ? (
        <p className="sr-only" role="status">
          {value.accepted ? `Propina: ${formatCOP(value.amount)}` : "Sin propina."}
        </p>
      ) : null}
    </div>
  );
}
