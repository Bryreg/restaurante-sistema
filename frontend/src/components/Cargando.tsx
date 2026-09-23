import { cn } from "@/lib/utils"

export interface CargandoProps {
  /** Qué se está trayendo, como lo diría la persona: «Cargando turnos de hoy…». */
  texto?: string
  /** Cuántos renglones de esqueleto. Tres se parecen a una lista; uno, a una cifra. */
  filas?: number
  className?: string
}

/**
 * **Cargando** (`docs/diseno/propuesta.html` § Estados): un esqueleto con la
 * forma del contenido, no una rueda girando, más el texto de qué se trae —que
 * es lo que anuncia el lector de pantalla y lo que ve quien tiene la conexión
 * lenta—. Respeta «reducir movimiento»: con esa preferencia el esqueleto no
 * late.
 */
export function Cargando({ texto = "Cargando…", filas = 3, className }: CargandoProps): React.JSX.Element {
  return (
    <div role="status" className={cn("space-y-2", className)}>
      <p className="text-sm text-muted-foreground">{texto}</p>
      <div aria-hidden="true" className="space-y-2">
        {Array.from({ length: filas }, (_, i) => (
          <div
            key={i}
            className="h-4 rounded bg-muted motion-safe:animate-pulse"
            style={{ width: i === filas - 1 && filas > 1 ? "55%" : i % 2 === 0 ? "100%" : "80%" }}
          />
        ))}
      </div>
    </div>
  )
}

export default Cargando
