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
  /** `"bloque"` ocupa su renglón; `"linea"` va dentro de un texto. */
  forma?: "linea" | "bloque";
  /**
   * El rayado de `.sin-dato`, **sólo para una celda chica de tabla** (el
   * mismo lenguaje que «Sin costo»). Por defecto no: en una tarjeta, un
   * bloque o al lado de un gráfico, la trama hacía que un día con pocos
   * datos se viera roto. Sin rayado se dice igual —nunca 0—, en gris y
   * en una frase.
   */
  rayado?: boolean;
  className?: string;
}

/**
 * **«Sin dato» no es cero** (`docs/diseno/propuesta.html` § Estados). Se
 * dice apagado, nunca en rojo ni en verde: no saber no es estar mal. Siempre
 * dice qué falta. Lleva la clase `.sin-dato` como marca (las pruebas y las
 * auditorías la buscan); el rayado sólo con `rayado`.
 */
export function SinDato({
  motivo,
  children = "Sin datos",
  forma = "linea",
  rayado = false,
  className,
}: SinDatoProps): React.JSX.Element {
  return (
    <span
      className={cn(
        "sin-dato",
        !rayado && "sin-dato--calmo",
        forma === "bloque"
          ? cn("block text-sm leading-snug", rayado && "px-2 py-1.5")
          : cn("inline", rayado && "px-1.5 py-0.5"),
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
