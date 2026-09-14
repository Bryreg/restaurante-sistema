import { DENOMINATIONS, formatCOP } from "@/lib/money";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export interface Denomination {
  value: number;
  count: number;
}

export interface DenominationsInputProps {
  value: Denomination[];
  onChange: (next: Denomination[]) => void;
  disabled?: boolean;
  legend?: string;
}

/**
 * Una fila por denominación con la cantidad contada (billetes de apertura,
 * conteo de cierre, retiro, cambio). El total que se ve acá es **sólo** la
 * suma de lo tecleado, calculada en el cliente para mostrarla mientras se
 * cuenta — nunca es "lo esperado" ni "la diferencia": esas cifras las
 * calcula el backend y se muestran aparte (AGENTS.md § "una sola
 * matemática en el backend").
 */
export function DenominationsInput({
  value,
  onChange,
  disabled = false,
  legend = "Denominaciones contadas",
}: DenominationsInputProps): React.JSX.Element {
  const countByValue = new Map(value.map((d) => [d.value, d.count]));
  const typedTotal = value.reduce((acc, d) => acc + d.value * d.count, 0);

  function handleCountChange(denomValue: number, rawCount: string) {
    const parsed = Math.trunc(Number(rawCount));
    const count = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const next = DENOMINATIONS.map((v) => ({
      value: v,
      count: v === denomValue ? count : countByValue.get(v) ?? 0,
    }));
    onChange(next);
  }

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid gap-2">
        {DENOMINATIONS.map((denomValue) => {
          const inputId = `denom-${denomValue}`;
          return (
            <div key={denomValue} className="flex items-center gap-3">
              <Label htmlFor={inputId} className="w-28 shrink-0 justify-end text-right tabular-nums">
                {formatCOP(denomValue)}
              </Label>
              <Input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className="h-11 w-24"
                disabled={disabled}
                value={countByValue.get(denomValue) ?? 0}
                onChange={(event) => handleCountChange(denomValue, event.target.value)}
              />
            </div>
          );
        })}
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Total tecleado: <span className="font-medium text-foreground">{formatCOP(typedTotal)}</span>
      </p>
    </fieldset>
  );
}
