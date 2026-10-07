import { useState } from "react";

import type { TipInfoOut } from "@/api/orders";
import type { PaymentTipIn } from "@/api/payments";
import { SegmentadoTactil } from "@/components/admin";
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
 * §2.4), como la dibuja el handoff (`design_handoff_pos_burbujas`, 9d):
 * «Propina voluntaria · la decide el cliente» y un segmentado de 60 px con
 * tres opciones — «10 % sugerida» con el
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

  const elegida = eligioOtra ? "otra" : eligioSugerida ? "sug" : eligioNinguna ? "no" : null;

  return (
    <div className="flex flex-col gap-2">
      <p className="px-1 text-sm font-semibold">
        Propina voluntaria <span className="font-normal text-muted-foreground">· la decide el cliente</span>
      </p>
      <p className="sr-only">¿Desea incluir servicio voluntario del {suggestedPct}%?</p>
      <SegmentadoTactil
        etiqueta="Propina"
        alto={60}
        columnas={3}
        apilado
        valor={elegida}
        onChange={(v) => (v === "sug" ? accept() : v === "no" ? decline() : setModifying(true))}
        opciones={[
          { value: "sug", label: `${suggestedPct} % sugerida`, detalle: formatCOP(suggestedAmount) },
          {
            value: "otra",
            label: "Otra",
            detalle: value?.modified && value.accepted ? formatCOP(value.amount) : "—",
          },
          { value: "no", label: "Sin propina", detalle: formatCOP(0) },
        ]}
      />

      {modifying ? (
        <div className="flex flex-wrap items-end gap-2 rounded-[18px] bg-muted p-3">
          <div className="min-w-0 flex-1 space-y-1">
            <Label htmlFor="tip-custom-amount" className="text-[13px] font-normal text-muted-foreground">
              Monto de propina
            </Label>
            <MoneyInput id="tip-custom-amount" value={customAmount} onChange={setCustomAmount} />
          </div>
          <Button type="button" className="h-12 rounded-[14px] px-4 text-[15px]" onClick={confirmCustom}>
            Confirmar
          </Button>
          <Button type="button" variant="ghost" className="h-12 px-3 text-[15px]" onClick={() => setModifying(false)}>
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
