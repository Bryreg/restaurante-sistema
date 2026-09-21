import { Banknote, Coins } from "lucide-react";

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
  /**
   * Cuántas columnas de denominaciones. `2` (por defecto) es la tablet
   * horizontal: billetes y monedas uno al lado del otro. `1` es para cuando
   * la rejilla ya vive dentro de una columna angosta — el canje de sencilla
   * pone DOS de estos lado a lado y cuatro columnas no entran.
   */
  columns?: 1 | 2;
}

/**
 * Billetes y monedas, de mayor a menor. El corte en $2.000 y el orden
 * descendente son los de la maqueta `m2b`: se cuenta el cajón empezando por
 * el billete grande, no por la moneda de $50.
 */
const BILLETES = DENOMINATIONS.filter((value) => value >= 2000)
  .slice()
  .sort((a, b) => b - a);
const MONEDAS = DENOMINATIONS.filter((value) => value < 2000)
  .slice()
  .sort((a, b) => b - a);

/**
 * Una fila por denominación con la cantidad contada (billetes de apertura,
 * conteo de cierre, retiro, cambio). El total que se ve acá es **sólo** la
 * suma de lo tecleado, calculada en el cliente para mostrarla mientras se
 * cuenta — nunca es "lo esperado" ni "la diferencia": esas cifras las
 * calcula el backend y se muestran aparte (AGENTS.md § "una sola
 * matemática en el backend").
 *
 * **Dos columnas** (maqueta `m2b`, pestaña «Cierre de caja»): en una sola
 * columna la mitad del cajón queda debajo del pliegue de una tablet de 10,5"
 * horizontal, y lo que hay que desplazar para ver se cuenta peor. El
 * subtotal de cada renglón va debajo de la denominación, no al lado, para
 * que la fila entre en la mitad del ancho.
 *
 * El **conteo de piezas** acompaña al total: dos personas que cuentan el
 * mismo cajón comparan primero cuántos papeles hay, no cuánta plata.
 */
export function DenominationsInput({
  value,
  onChange,
  disabled = false,
  legend = "Denominaciones contadas",
  columns = 2,
}: DenominationsInputProps): React.JSX.Element {
  const countByValue = new Map(value.map((d) => [d.value, d.count]));
  const typedTotal = value.reduce((acc, d) => acc + d.value * d.count, 0);
  const typedPieces = value.reduce((acc, d) => acc + d.count, 0);

  function handleCountChange(denomValue: number, rawCount: string) {
    const parsed = Math.trunc(Number(rawCount));
    const count = rawCount.trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    const next = DENOMINATIONS.map((v) => ({
      value: v,
      count: v === denomValue ? count : countByValue.get(v) ?? 0,
    }));
    onChange(next);
  }

  function grupo(titulo: string, Icono: typeof Banknote, valores: number[]) {
    return (
      <div className="min-w-0">
        <p className="flex items-center gap-2 border-b border-input pb-1.5 text-sm font-medium text-muted-foreground">
          <Icono aria-hidden="true" className="size-4" />
          {titulo}
        </p>
        {valores.map((denomValue) => {
          const inputId = `denom-${denomValue}`;
          const count = countByValue.get(denomValue) ?? 0;
          return (
            <div
              key={denomValue}
              className="flex items-center gap-3 border-b border-border py-1.5 last:border-b-0"
            >
              <Label htmlFor={inputId} className="min-w-0 flex-1 flex-col items-start gap-0">
                <span className="text-base font-bold tabular-nums">{formatCOP(denomValue)}</span>
                <span
                  aria-hidden={count > 0 ? undefined : "true"}
                  className="text-xs font-normal tabular-nums text-muted-foreground"
                >
                  {count > 0 ? formatCOP(denomValue * count) : " "}
                </span>
              </Label>
              <Input
                id={inputId}
                type="number"
                inputMode="numeric"
                min={0}
                step={1}
                className="h-11 w-20 shrink-0 text-center"
                disabled={disabled}
                // Vacío, NO `0`: un `0` precargado obliga a borrarlo antes de
                // teclear, y quien cuenta efectivo en una tablet no lo borra —
                // teclea encima y le queda "010". Además un campo en blanco
                // dice "todavía no conté", que no es lo mismo que "conté cero"
                // (`docs/SPEC-NEGOCIO.md §9.3`: «sin datos» se dice, no se
                // dibuja como cero).
                value={countByValue.get(denomValue) || ""}
                // Contar efectivo es corregir: al tocar el campo se selecciona
                // lo que haya, así retecleás en vez de agregarle dígitos.
                onFocus={(event) => event.target.select()}
                onChange={(event) => handleCountChange(denomValue, event.target.value)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <fieldset className="min-w-0 space-y-3" disabled={disabled}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className={columns === 2 ? "grid gap-x-6 sm:grid-cols-2" : "grid max-w-sm gap-x-6"}>
        {grupo("Billetes", Banknote, BILLETES)}
        {grupo("Monedas", Coins, MONEDAS)}
      </div>
      <p
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-2 border-foreground bg-muted px-3 py-2.5 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <span>Total tecleado</span>
        <span className="rounded-full bg-card px-2 py-0.5 text-xs tabular-nums ring-1 ring-border">
          {typedPieces === 1 ? "1 pieza" : `${typedPieces} piezas`}
        </span>
        <span className="ml-auto text-xl font-bold tabular-nums text-foreground">
          {formatCOP(typedTotal)}
        </span>
      </p>
    </fieldset>
  );
}
