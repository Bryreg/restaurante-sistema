import { Banknote, ChevronRight, Coins, Delete, Minus, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import type { Denomination } from "./DenominationsInput";

export interface DenominationKeypadProps {
  value: Denomination[];
  onChange: (next: Denomination[]) => void;
  disabled?: boolean;
  legend?: string;
  /** Muestra la leyenda (por defecto) o la deja sólo para lectores de pantalla, cuando la pantalla ya la titula. */
  legendVisible?: boolean;
  /** Rótulo del total: «Total tecleado» (cierre) o «Total contado» (sobres). */
  totalLabel?: string;
  /**
   * Lo que va al lado del total, a la derecha (p. ej. «Sellar sobre» en la
   * apertura por sobres), y una nota debajo. Así la pantalla que lo contiene
   * no repite el total.
   */
  accion?: ReactNode;
  nota?: ReactNode;
}

/** Billetes y monedas, de mayor a menor: se cuenta empezando por el billete grande. */
const BILLETES = DENOMINATIONS.filter((v) => v >= 2000)
  .slice()
  .sort((a, b) => b - a);
const MONEDAS = DENOMINATIONS.filter((v) => v < 2000)
  .slice()
  .sort((a, b) => b - a);
/** El orden en que avanza «Siguiente»: todos los billetes y después las monedas. */
const ORDEN = [...BILLETES, ...MONEDAS];

/** Tope de piezas por denominación: cuatro dígitos (nadie tiene 10.000 billetes de uno). */
const MAX_PIEZAS = 9999;

const TECLAS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * **Teclado en pantalla para contar plata por denominación** (auditoría de
 * tablet): las once denominaciones eran campos `type=number` que abrían el
 * teclado del sistema, tapaban media pantalla y había que tocar cada campo.
 *
 * Una denominación está **activa** (resaltada); el teclado numérico escribe
 * cuántas piezas hay de ella —el primer dígito reemplaza lo que había, como
 * un campo seleccionado— y «Siguiente» pasa a la denominación que sigue, así
 * que se cuenta el cajón de corrido sin buscar el campo. Cada renglón tiene
 * además −/+ para sumar o quitar una pieza (el billete que apareció al
 * final). Con teclado físico funciona igual, pero sólo cuando el foco está
 * adentro del componente (nunca escucha en `window`: `docs/CONTEXTO-AGENTES
 * §14.8`).
 *
 * Como `DenominationsInput`, el total que se ve es **sólo la suma de lo
 * tecleado** para mostrarla mientras se cuenta —la misma cifra que viaja
 * como `total` del desglose, que el servidor vuelve a sumar y valida—; nunca
 * es el esperado ni la diferencia.
 */
export function DenominationKeypad({
  value,
  onChange,
  disabled = false,
  legend = "Denominaciones contadas",
  legendVisible = true,
  totalLabel = "Total tecleado",
  accion,
  nota,
}: DenominationKeypadProps): React.JSX.Element {
  const [activa, setActiva] = useState<number>(ORDEN[0]!);
  // El próximo dígito reemplaza (recién elegida la denominación) o agrega.
  const [reemplaza, setReemplaza] = useState(true);

  const porValor = new Map(value.map((d) => [d.value, d.count]));
  const piezasDe = (v: number) => porValor.get(v) ?? 0;
  const totalTecleado = value.reduce((acc, d) => acc + d.value * d.count, 0);
  const piezas = value.reduce((acc, d) => acc + d.count, 0);

  function fijar(v: number, count: number) {
    const limpio = Math.max(0, Math.min(MAX_PIEZAS, Math.trunc(count)));
    onChange(DENOMINATIONS.map((d) => ({ value: d, count: d === v ? limpio : piezasDe(d) })));
  }

  function elegir(v: number) {
    setActiva(v);
    setReemplaza(true);
  }

  function digito(d: number) {
    if (disabled) return;
    const base = reemplaza ? 0 : piezasDe(activa);
    const siguiente = base * 10 + d;
    if (siguiente > MAX_PIEZAS) return;
    fijar(activa, siguiente);
    setReemplaza(false);
  }

  function borrar() {
    if (disabled) return;
    fijar(activa, Math.floor(piezasDe(activa) / 10));
    setReemplaza(false);
  }

  function avanzar() {
    const i = ORDEN.indexOf(activa);
    if (i >= 0 && i < ORDEN.length - 1) elegir(ORDEN[i + 1]!);
    else setReemplaza(true);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLFieldSetElement>) {
    if (disabled || event.altKey || event.ctrlKey || event.metaKey) return;
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      digito(Number(event.key));
    } else if (event.key === "Backspace") {
      event.preventDefault();
      borrar();
    } else if (event.key === "Enter") {
      event.preventDefault();
      avanzar();
    }
  }

  function renglon(v: number, moneda: boolean) {
    const count = piezasDe(v);
    const esActiva = v === activa;
    const pieza = moneda ? "moneda" : "billete";
    const una = moneda ? "una" : "un";
    const lado =
      "grid size-[56px] shrink-0 place-items-center rounded-[10px] border bg-background text-foreground hover:bg-muted disabled:opacity-40";
    return (
      <li key={v} className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Quitar ${una} ${pieza} de ${formatCOP(v)}`}
          disabled={disabled || count === 0}
          onClick={() => fijar(v, count - 1)}
          className={lado}
        >
          <Minus aria-hidden="true" className="size-5" />
        </button>
        <button
          type="button"
          aria-pressed={esActiva}
          aria-label={`${formatCOP(v)}: ${count === 0 ? "sin contar" : `${count} ${count === 1 ? pieza : `${pieza}s`}`}`}
          disabled={disabled}
          onClick={() => elegir(v)}
          className={cn(
            "flex h-[56px] min-w-0 flex-1 items-center justify-between gap-1 rounded-[10px] border px-3 text-left transition-colors",
            esActiva ? "border-foreground bg-foreground text-background" : "bg-card hover:bg-muted",
          )}
        >
          <span className="flex min-w-0 flex-col items-start leading-[1.1]">
            <b className="text-[17px] tabular-nums">{formatCOP(v)}</b>
            <span className="text-[13px] tabular-nums opacity-80">{count > 0 ? formatCOP(v * count) : " "}</span>
          </span>
          <b className="text-[26px] tabular-nums">{count > 0 ? count : "–"}</b>
        </button>
        <button
          type="button"
          aria-label={`Sumar ${una} ${pieza} de ${formatCOP(v)}`}
          disabled={disabled || count >= MAX_PIEZAS}
          onClick={() => fijar(v, count + 1)}
          className={lado}
        >
          <Plus aria-hidden="true" className="size-5" />
        </button>
      </li>
    );
  }

  const tecla =
    "grid h-[64px] place-items-center rounded-[10px] border bg-background text-[24px] font-semibold tabular-nums hover:bg-muted active:bg-muted disabled:opacity-40";

  const total = (
    <p
      className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t-2 border-foreground bg-muted px-3.5 py-3 text-[15px] text-muted-foreground"
      aria-live="polite"
    >
      <span>{totalLabel}</span>
      <span className="rounded-full border bg-card px-2 py-0.5 text-[13px] text-foreground tabular-nums">
        {piezas === 1 ? "1 pieza" : `${piezas} piezas`}
      </span>
      <b className="ml-auto text-[28px] text-foreground tabular-nums">{formatCOP(totalTecleado)}</b>
    </p>
  );

  return (
    // `@container`: tres columnas (billetes, monedas, teclado) cuando el
    // conteo tiene el ancho de la tablet vertical; en una hoja angosta, el
    // teclado baja.
    <fieldset className="@container min-w-0 space-y-3.5" disabled={disabled} onKeyDown={onKeyDown}>
      <legend className={legendVisible ? "text-sm font-medium" : "sr-only"}>{legend}</legend>
      <div className="grid gap-3.5 @min-[640px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_232px] @min-[440px]:grid-cols-2">
        <div className="min-w-0 space-y-1.5">
          <p className="flex items-center gap-1.5 text-[15px] font-semibold text-muted-foreground">
            <Banknote aria-hidden="true" className="size-4" /> Billetes
          </p>
          <ul className="space-y-1.5">{BILLETES.map((v) => renglon(v, false))}</ul>
        </div>
        <div className="min-w-0 space-y-1.5">
          <p className="flex items-center gap-1.5 text-[15px] font-semibold text-muted-foreground">
            <Coins aria-hidden="true" className="size-4" /> Monedas
          </p>
          <ul className="space-y-1.5">{MONEDAS.map((v) => renglon(v, true))}</ul>
        </div>

        <div className="space-y-1.5 @min-[440px]:col-span-2 @min-[640px]:col-span-1 @min-[640px]:sticky @min-[640px]:top-2 @min-[640px]:self-start">
          <p className="rounded-[10px] bg-muted px-3 py-2 text-[15px] text-muted-foreground" aria-live="polite">
            Contando <b className="text-foreground tabular-nums">{formatCOP(activa)}</b>:{" "}
            <b className="text-[20px] text-foreground tabular-nums">{piezasDe(activa)}</b>
          </p>
          <div role="group" aria-label="Teclado numérico" className="grid grid-cols-3 gap-1.5">
            {TECLAS.map((t) => (
              <button key={t} type="button" className={tecla} disabled={disabled} onClick={() => digito(Number(t))}>
                {t}
              </button>
            ))}
            <button type="button" className={tecla} aria-label="Borrar un dígito" disabled={disabled} onClick={borrar}>
              <Delete aria-hidden="true" className="size-6" />
            </button>
            <button type="button" className={tecla} disabled={disabled} onClick={() => digito(0)}>
              0
            </button>
            <button
              type="button"
              aria-label="Siguiente denominación"
              disabled={disabled}
              onClick={avanzar}
              className="grid h-[64px] place-items-center rounded-[10px] border border-foreground bg-foreground text-background hover:opacity-90 disabled:opacity-40"
            >
              <ChevronRight aria-hidden="true" className="size-6" />
            </button>
          </div>
        </div>
      </div>
      {accion ? (
        <div className="grid items-stretch gap-3.5 @min-[640px]:grid-cols-[minmax(0,1fr)_300px]">
          <div className="flex flex-col gap-1">
            {total}
            {nota ? <p className="text-[14px] text-muted-foreground">{nota}</p> : null}
          </div>
          {accion}
        </div>
      ) : (
        <>
          {total}
          {nota ? <p className="text-[14px] text-muted-foreground">{nota}</p> : null}
        </>
      )}
    </fieldset>
  );
}
