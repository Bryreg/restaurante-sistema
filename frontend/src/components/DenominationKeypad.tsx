import { Banknote, ChevronRight, Coins, Delete, Minus, Plus } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";
import { DENOMINATIONS, formatCOP } from "@/lib/money";

import type { Denomination } from "./DenominationsInput";

export interface DenominationKeypadProps {
  value: Denomination[];
  onChange: (next: Denomination[]) => void;
  disabled?: boolean;
  legend?: string;
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
    return (
      <li key={v} className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label={`Quitar ${una} ${pieza} de ${formatCOP(v)}`}
          disabled={disabled || count === 0}
          onClick={() => fijar(v, count - 1)}
          className="grid size-12 shrink-0 place-items-center rounded-lg bg-card ring-1 ring-border hover:bg-muted disabled:opacity-40"
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
            "flex h-12 min-w-0 flex-1 items-center justify-between gap-2 rounded-lg px-3 text-left ring-1 transition-colors",
            esActiva ? "bg-foreground text-background ring-foreground" : "bg-card ring-border hover:bg-muted",
          )}
        >
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-base font-bold tabular-nums">{formatCOP(v)}</span>
            <span className={cn("text-xs tabular-nums", esActiva ? "text-background/80" : "text-muted-foreground")}>
              {count > 0 ? formatCOP(v * count) : " "}
            </span>
          </span>
          <span className="text-2xl font-bold tabular-nums">{count > 0 ? count : "–"}</span>
        </button>
        <button
          type="button"
          aria-label={`Sumar ${una} ${pieza} de ${formatCOP(v)}`}
          disabled={disabled || count >= MAX_PIEZAS}
          onClick={() => fijar(v, count + 1)}
          className="grid size-12 shrink-0 place-items-center rounded-lg bg-card ring-1 ring-border hover:bg-muted disabled:opacity-40"
        >
          <Plus aria-hidden="true" className="size-5" />
        </button>
      </li>
    );
  }

  const tecla =
    "grid h-14 place-items-center rounded-lg bg-card text-2xl font-semibold tabular-nums ring-1 ring-border hover:bg-muted active:bg-muted disabled:opacity-40";

  return (
    <fieldset className="min-w-0 space-y-3" disabled={disabled} onKeyDown={onKeyDown}>
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Banknote aria-hidden="true" className="size-4" /> Billetes
            </p>
            <ul className="space-y-1.5">{BILLETES.map((v) => renglon(v, false))}</ul>
          </div>
          <div className="min-w-0 space-y-1.5">
            <p className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <Coins aria-hidden="true" className="size-4" /> Monedas
            </p>
            <ul className="space-y-1.5">{MONEDAS.map((v) => renglon(v, true))}</ul>
          </div>
        </div>

        <div className="space-y-2 lg:sticky lg:top-2 lg:self-start">
          <p className="rounded-lg bg-muted px-3 py-2 text-sm" aria-live="polite">
            <span className="text-muted-foreground">Contando </span>
            <b className="tabular-nums">{formatCOP(activa)}</b>
            <span className="text-muted-foreground">: </span>
            <b className="text-lg tabular-nums">{piezasDe(activa)}</b>
          </p>
          <div role="group" aria-label="Teclado numérico" className="grid grid-cols-3 gap-2">
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
              className="grid h-14 place-items-center rounded-lg bg-foreground text-background ring-1 ring-foreground hover:opacity-90 disabled:opacity-40"
            >
              <ChevronRight aria-hidden="true" className="size-7" />
            </button>
          </div>
        </div>
      </div>
      <p
        className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t-2 border-foreground bg-muted px-3 py-2.5 text-sm text-muted-foreground"
        aria-live="polite"
      >
        <span>Total tecleado</span>
        <span className="rounded-full bg-card px-2 py-0.5 text-xs tabular-nums ring-1 ring-border">
          {piezas === 1 ? "1 pieza" : `${piezas} piezas`}
        </span>
        <span className="ml-auto text-xl font-bold tabular-nums text-foreground">{formatCOP(totalTecleado)}</span>
      </p>
    </fieldset>
  );
}
