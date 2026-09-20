import { Delete } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PinPadProps {
  /** 4 dígitos (persona) o 6 (sede) — spec § 2.1 y § "Auth & identity". */
  length?: 4 | 6;
  /** Anuncia el propósito del teclado a lectores de pantalla. */
  label: string;
  onSubmit: (pin: string) => void;
  disabled?: boolean;
  /** Mensaje del servidor (p. ej. `PIN_LOCKED`) mostrado tal cual llegó. */
  errorMessage?: string | null;
}

const ROWS: readonly (readonly string[])[] = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
];

/**
 * Teclado numérico accesible: botones ≥ 44px con `aria-label`, operable con
 * el teclado físico (dígitos y Backspace), y un `aria-live` que anuncia el
 * progreso sin exponer el PIN a un lector de pantalla dígito por dígito de
 * forma redundante con la pantalla.
 */
export function PinPad({ length = 4, label, onSubmit, disabled = false, errorMessage = null }: PinPadProps) {
  const [value, setValue] = useState("");
  const statusId = useId();
  const errorId = useId();

  const append = useCallback(
    (digit: string) => {
      if (disabled) return;
      setValue((prev) => (prev.length >= length ? prev : prev + digit));
    },
    [disabled, length],
  );

  const backspace = useCallback(() => {
    if (disabled) return;
    setValue((prev) => prev.slice(0, -1));
  }, [disabled]);

  // Cuando se completan los dígitos, se avisa y se limpia — en un efecto,
  // nunca dentro del actualizador de `setValue`, para no disparar `onSubmit`
  // más de una vez si React re-invoca el actualizador (StrictMode).
  useEffect(() => {
    if (value.length < length) return;
    onSubmit(value);
    setValue("");
  }, [value, length, onSubmit]);

  useEffect(() => {
    // El atajo de teclado escucha en `window` para que no haga falta enfocar
    // el teclado numérico antes de teclear el PIN. Eso obliga a una guarda:
    // **si el foco está en otro campo, la tecla es de ese campo, no del PIN.**
    //
    // Sin la guarda, cualquier dígito tecleado en un input de la misma
    // pantalla se lo comía el PIN. El caso real, encontrado en el recorrido
    // en navegador de la fase 3: pagar una cuenta por pagar. Se teclea el
    // monto «50000»; en cuanto el primer dígito hace válido el monto, el
    // teclado de PIN se habilita y se traga los CUATRO ceros siguientes —
    // cuatro dígitos es un PIN completo, así que **dispara el pago solo, con
    // un PIN inventado**. Y un PIN equivocado cuenta para el bloqueo por
    // intentos fallidos (`PIN_LOCK_ATTEMPTS`), así que además deja a la
    // persona fuera.
    //
    // Estaba tapado porque `MoneyInput` sólo avisaba del monto al salir del
    // campo, así que el teclado de PIN todavía estaba deshabilitado mientras
    // se tecleaba. Al arreglar eso, el defecto quedó a la vista. No lo creó
    // ese arreglo: cualquier pantalla con un PIN y un campo numérico
    // habilitados a la vez lo tenía.
    function focoEnOtroCampo(): boolean {
      const activo = document.activeElement as HTMLElement | null;
      if (activo === null) return false;
      if (activo.isContentEditable) return true;
      const tag = activo.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    function onKeyDown(event: KeyboardEvent) {
      if (disabled) return;
      if (focoEnOtroCampo()) return;
      if (event.key >= "0" && event.key <= "9") {
        append(event.key);
      } else if (event.key === "Backspace") {
        event.preventDefault();
        backspace();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [append, backspace, disabled]);

  return (
    <div className="flex flex-col items-center gap-4" role="group" aria-label={label}>
      <div className="flex gap-3" aria-hidden="true">
        {Array.from({ length }).map((_, index) => (
          <span
            key={index}
            className={cn(
              "size-4 rounded-full border-2 border-foreground/40",
              index < value.length && "border-foreground bg-foreground",
            )}
          />
        ))}
      </div>
      <p id={statusId} className="sr-only" role="status" aria-live="polite">
        {value.length} de {length} dígitos ingresados
      </p>
      {errorMessage ? (
        <p id={errorId} role="alert" className="text-center text-sm font-medium text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <div
        className="grid grid-cols-3 gap-3"
        aria-describedby={errorMessage ? errorId : statusId}
      >
        {ROWS.flat().map((digit) => (
          <Button
            key={digit}
            type="button"
            variant="outline"
            className="h-14 w-14 text-xl"
            aria-label={`Dígito ${digit}`}
            disabled={disabled}
            onClick={() => append(digit)}
          >
            {digit}
          </Button>
        ))}
        <span aria-hidden="true" />
        <Button
          key="0"
          type="button"
          variant="outline"
          className="h-14 w-14 text-xl"
          aria-label="Dígito 0"
          disabled={disabled}
          onClick={() => append("0")}
        >
          0
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-14 w-14"
          aria-label="Borrar último dígito"
          disabled={disabled || value.length === 0}
          onClick={backspace}
        >
          <Delete className="size-5" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
