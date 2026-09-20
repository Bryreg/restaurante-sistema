import { useEffect, useRef, useState } from "react";

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
  const ref = useRef<HTMLInputElement>(null);

  // Seleccionar el contenido al enfocar, DESPUÉS del render.
  //
  // Al tomar foco el campo cambia lo que muestra: de `formatCOP(value)`
  // («$ 0») al texto crudo («0»). Seleccionar dentro del `onFocus` no sirve
  // —React vuelve a renderizar enseguida y borra la selección—, así que
  // tecleando sobre un campo en cero salía «062400» en vez de «62400». Es el
  // mismo defecto que apareció contando efectivo en el POS, y acá cae en los
  // campos de impuesto de una recepción.
  useEffect(() => {
    if (focused) ref.current?.select();
  }, [focused]);

  useEffect(() => {
    if (!focused) {
      setText(value === null ? "" : String(value));
    }
  }, [value, focused]);

  return (
    <Input
      ref={ref}
      id={id}
      type="text"
      inputMode="numeric"
      className="h-11"
      disabled={disabled}
      placeholder={placeholder}
      value={focused ? text : value === null ? "" : formatCOP(value)}
      // Seleccionar al enfocar: si el campo ya trae un número, teclear lo
      // REEMPLAZA en vez de pegarse adelante. Sin esto, tocar un campo con
      // «$ 0» y teclear 2600 daba «02600» — el defecto que apareció primero
      // contando efectivo en el POS y después en los impuestos de una
      // recepción. Vale para todos los campos de plata de la app.
      onFocus={() => setFocused(true)}
      // Se AVISA en cada tecla, no sólo al salir del campo.
      //
      // Antes sólo se avisaba en `onBlur`, y eso dejaba una trampa que el
      // recorrido en navegador real de la fase 3 encontró: un formulario que
      // habilita su botón según el monto (casi todos los de plata de esta app)
      // seguía con el botón DESHABILITADO mientras el campo tuviera el foco.
      // Y hacer clic en un botón deshabilitado **no saca el foco del campo**
      // en Chromium: el mousedown se descarta. Así que la persona teclea el
      // monto, ve el botón gris, y no tiene forma de destrabarlo salvo
      // adivinar que primero hay que tocar en otro lado.
      //
      // Avisar en cada tecla no rompe nada de lo que `onBlur` defendía: el
      // segundo `useEffect` sólo copia `value` -> `text` cuando el campo NO
      // tiene foco, así que lo que la persona está escribiendo no se le
      // reescribe a mitad. El `onBlur` se conserva para el caso en que el
      // texto quede en algo que `parseCOP` normaliza distinto.
      onChange={(event) => {
        setText(event.target.value);
        onChange(parseCOP(event.target.value));
      }}
      onBlur={() => {
        setFocused(false);
        onChange(parseCOP(text));
      }}
      {...aria}
    />
  );
}
