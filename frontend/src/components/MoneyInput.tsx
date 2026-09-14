import { useEffect, useState } from "react";

import { Input } from "@/components/ui/input";
import { formatCOP, parseCOP } from "@/lib/money";

export interface MoneyInputProps {
  id?: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}

/**
 * Entero de pesos: muestra `formatCOP` cuando no tiene foco y el texto tal
 * cual se tecleó mientras se edita; al perder el foco convierte con
 * `parseCOP`. Nunca deja pasar decimales de centavo (AGENTS.md § "dinero en
 * enteros de pesos").
 */
export function MoneyInput({
  id,
  value,
  onChange,
  disabled = false,
  placeholder = "$ 0",
  ...aria
}: MoneyInputProps): React.JSX.Element {
  const [text, setText] = useState(value === null ? "" : String(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setText(value === null ? "" : String(value));
    }
  }, [value, focused]);

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      className="h-11"
      disabled={disabled}
      placeholder={placeholder}
      value={focused ? text : value === null ? "" : formatCOP(value)}
      onFocus={() => setFocused(true)}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => {
        setFocused(false);
        onChange(parseCOP(text));
      }}
      {...aria}
    />
  );
}
