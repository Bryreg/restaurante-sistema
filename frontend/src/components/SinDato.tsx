import { cn } from "@/lib/utils";

export interface SinDatoProps {
  /**
   * **Qué falta**, obligatorio: «falta el conteo del lunes», «todavía no hay
   * compras en la semana». Un «sin dato» que no dice qué falta es el mismo
   * silencio que un `$ 0` (SPEC-NEGOCIO § 9.3). `null` sólo cuando el motivo
   * lo da el servidor y esta vez no lo mandó: la interfaz no inventa uno.
   */
  motivo: string | null | undefined;
  /** Lo que se ve antes del motivo. Por defecto, «Sin datos», que es como lo dice el resto del sistema (y lo que buscan las auditorías de `src/audit`). */
  children?: React.ReactNode;
  /** `"bloque"` rellena la celda o la tarjeta; `"linea"` va dentro de un texto. */
  forma?: "linea" | "bloque";
  className?: string;
}

/**
 * **«Sin dato» no es cero** (`docs/diseno/propuesta.html` § Estados). Se
 * dibuja rayado y en cursiva, nunca en rojo ni en verde: no saber no es estar
 * mal. Siempre dice qué falta.
 */
export function SinDato({
  motivo,
  children = "Sin datos",
  forma = "linea",
  className,
}: SinDatoProps): React.JSX.Element {
  return (
    <span
      className={cn(
        "sin-dato",
        forma === "bloque"
          ? "block px-2 py-1.5 text-sm"
          : "inline px-1.5 py-0.5",
        className,
      )}
    >
      <span className="font-medium not-italic">{children}</span>
      {motivo ? (
        <>
          {": "}
          <span>{motivo}</span>
        </>
      ) : null}
    </span>
  );
}

export default SinDato;
