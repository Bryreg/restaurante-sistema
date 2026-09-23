import { ArrowRight } from "lucide-react"

import { formatCOP } from "@/lib/money"
import { cn } from "@/lib/utils"

export interface DesdeHaciaProps {
  /** De dónde sale la plata, en palabras: «Cajón del turno 14». */
  desde: string
  /** Adónde va: «Sobre SOBRE-0921», «Banco», «Frigorífico El Llano». */
  hacia: string
  /** El monto tal como se va a mandar. `null` mientras no se escribió. */
  monto: number | null
  /** El verbo del renglón del monto: «Sale», «Se paga», «Se consigna». */
  verbo?: string
  /** Quién autoriza, si hace falta: «PIN de administrador». */
  autoriza?: string
  /**
   * **Cómo queda**, sólo si el servidor lo mandó. La interfaz no resta el
   * monto de un saldo para adivinarlo (una sola matemática, en el backend), y
   * en la caja del salón ni siquiera lo conoce: el cierre es a ciegas.
   */
  queda?: { label: string; valor: number }
  className?: string
}

/**
 * **Confirmar lo que mueve plata** (`docs/diseno/propuesta.html` § Componentes
 * clave): siempre dice de dónde sale, adónde va y cuánto. El botón que la
 * acompaña repite el monto —«Retirar $ 750.000», nunca «Aceptar»—, porque
 * con la fila de gente la confirmación es el número.
 */
export function DesdeHacia({
  desde,
  hacia,
  monto,
  verbo = "Sale",
  autoriza,
  queda,
  className,
}: DesdeHaciaProps): React.JSX.Element {
  return (
    <div className={cn("space-y-2 rounded-lg border bg-card p-4", className)} aria-live="polite">
      {autoriza ? <p className="text-xs text-muted-foreground">Autoriza: {autoriza}</p> : null}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
        <span>{desde}</span>
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-label="hacia" />
        <span>{hacia}</span>
      </p>
      <p className="text-2xl font-bold tabular-nums" style={{ fontStretch: "112%" }}>
        {verbo}: {monto === null ? "—" : formatCOP(monto)}
      </p>
      {queda ? (
        <p className="text-sm text-muted-foreground tabular-nums">
          {queda.label}: <b className="text-foreground">{formatCOP(queda.valor)}</b>
        </p>
      ) : null}
    </div>
  )
}

export default DesdeHacia
