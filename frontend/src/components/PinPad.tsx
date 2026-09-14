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
    function onKeyDown(event: KeyboardEvent) {
      if (disabled) return;
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
