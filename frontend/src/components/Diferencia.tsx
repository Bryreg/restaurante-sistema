import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

import { SinDato } from "./SinDato"

export interface DiferenciaProps {
  /** La diferencia **con signo, tal como la manda el servidor**. Acá no se resta nada. */
  valor: number | null | undefined
  /**
   * Qué signo es plata que falta. En caja y en conciliación la diferencia es
   * contado − esperado: negativo es faltante. En la varianza de inventario es
   * consumo real − teórico: positivo es lo que se fue sin venderse.
   */
  faltaCuando?: "negativo" | "positivo"
  /** Por qué no hay diferencia, cuando el servidor manda `null`. */
  motivoSinDato?: string | null
  className?: string
}

/**
 * **Fila de plata** (`docs/diseno/propuesta.html` § Componentes clave): la
 * dirección va con flecha y palabra, no sólo con color —quien no distingue el
 * rojo del verde lee «▼ faltante» igual—. El rojo es sólo para lo que falta;
 * lo que sobra va en ámbar, porque también pide explicación; lo que cuadra,
 * en verde.
 *
 * La cifra va **con su signo, tal como llegó**, aunque la flecha ya lo diga:
 * el signo es del servidor y la flecha es la lectura. Quitárselo convertiría
 * una varianza negativa (un sobrante) en el mismo número que un faltante si
 * alguien lee sólo la cifra (`src/audit/menu-engineering.test.tsx`).
 */
export function Diferencia({
  valor,
  faltaCuando = "negativo",
  motivoSinDato,
  className,
}: DiferenciaProps): React.JSX.Element {
  if (valor === null || valor === undefined) {
    return <SinDato motivo={motivoSinDato} className={className} />
  }
  if (valor === 0) {
    return <span className={cn("font-medium whitespace-nowrap text-success tabular-nums", className)}>= $ 0 cuadra</span>
  }
  const falta = faltaCuando === "negativo" ? valor < 0 : valor > 0
  return (
    <span
      className={cn(
        "font-semibold whitespace-nowrap tabular-nums",
        falta ? "text-destructive" : "text-warning",
        className,
      )}
    >
      <span aria-hidden="true">{falta ? "▼" : "▲"} </span>
      {formatCOP(valor)} {falta ? "faltante" : "sobrante"}
    </span>
  )
}

export default Diferencia
