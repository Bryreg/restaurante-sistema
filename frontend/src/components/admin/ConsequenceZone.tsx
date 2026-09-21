import { ShieldAlert, TriangleAlert } from "lucide-react"
import { useState } from "react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * **Los dos niveles** (`docs/PATRONES-ADMIN.md` § 11). Si todo lo que sale de
 * la pantalla se marca en rojo, el rojo deja de querer decir «esto no se
 * deshace».
 *
 * - `"reversible"` · **ámbar, «Cambia otra pantalla»**: no pierde nada
 *   —apagar la foto obligatoria no borra las 46 ya tomadas; la foto
 *   simplemente deja de pedirse—.
 * - `"irreversible"` · **rojo, «Zona de riesgo»**: no se deshace —el PIN
 *   nuevo no se vuelve a mostrar—.
 */
export type ConsequenceLevel = "reversible" | "irreversible"

const LEVEL_TITLE: Record<ConsequenceLevel, string> = {
  reversible: "Cambia otra pantalla",
  irreversible: "Zona de riesgo",
}

/**
 * El peligro va **en el marco**. Éstos son los únicos colores de estado que
 * el componente usa, y ninguno llega nunca al botón.
 */
const LEVEL_FRAME: Record<ConsequenceLevel, string> = {
  reversible: "border-warning/50 bg-warning/5",
  irreversible: "border-destructive/50 bg-destructive/5",
}

const LEVEL_HEADER: Record<ConsequenceLevel, string> = {
  reversible: "border-b-warning/50 bg-warning/10 text-warning",
  irreversible: "border-b-destructive/50 bg-destructive/10 text-destructive",
}

/**
 * **El botón: azul y secundario.** Una sola constante, usada por el disparador
 * y por la confirmación, para que no haya dos criterios. Es azul porque azul
 * es lo único que se toca (`docs/DISENO.md` § La regla del color) y es
 * secundario para que no sea lo más fácil de pulsar.
 */
const BLUE_AND_SECONDARY = "border-primary/40 text-primary hover:bg-accent hover:text-primary"

export interface ConsequenceAction {
  label: string
  onClick: () => void
  disabled?: boolean
  /**
   * **Qué cambia y dónde se va a notar.** La confirmación las enumera una por
   * una. Es una tupla no vacía: una acción de consecuencia sin consecuencias
   * declaradas no compila, que es la única forma de que el diálogo no termine
   * diciendo «¿Estás seguro?».
   */
  consequences: readonly [string, ...string[]]
  /** El título del diálogo. Por defecto, el rótulo de la acción. */
  confirmTitle?: string
}

export interface ConsequenceZoneProps {
  level: ConsequenceLevel
  /** Por defecto, el del patrón: «Cambia otra pantalla» / «Zona de riesgo». */
  title?: string
  /** Y a qué alcanza: «Zona de riesgo · Sede Chapinero». */
  scope?: string
  /** Por qué el marco avisa: qué cambia, qué NO se pierde, qué no se deshace. */
  explanation: React.ReactNode
  /** El contenido: las casillas, la explicación de la acción. */
  children?: React.ReactNode
  /**
   * La acción, si la zona tiene una. **El componente la dibuja**: no hay
   * `variant`, ni `className`, ni `render`, ni se acepta un botón ya hecho.
   * Un botón rojo acá no es algo que se desaconseje: es algo que la API no
   * sabe expresar.
   */
  action?: ConsequenceAction
  className?: string
}

/**
 * **Las dos zonas de consecuencia** (`docs/PATRONES-ADMIN.md` § 11). El
 * peligro se marca en el marco; el botón es azul y secundario; la
 * confirmación enumera qué cambia y dónde se va a notar.
 *
 * Aplica a Funciones, Fiscal y Sedes (ámbar); y a Aplicar conteo, Anonimizar
 * cliente, Revertir recepción, Apagar función y Rotar PIN (rojo).
 */
export function ConsequenceZone({
  level,
  title,
  scope,
  explanation,
  children,
  action,
  className,
}: ConsequenceZoneProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const Icon = level === "irreversible" ? ShieldAlert : TriangleAlert
  const heading = [title ?? LEVEL_TITLE[level], scope].filter(Boolean).join(" · ")

  return (
    <section className={cn("overflow-hidden rounded-lg border", LEVEL_FRAME[level], className)}>
      <header className={cn("flex items-start gap-2.5 border-b px-3 py-2.5", LEVEL_HEADER[level])}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="text-xs font-bold tracking-wider uppercase">{heading}</h3>
          <p className="mt-0.5 max-w-[76ch] text-xs leading-relaxed text-foreground">{explanation}</p>
        </div>
      </header>

      {children || action ? (
        <div className="bg-card px-3 py-3">
          {children}
          {action ? (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={action.disabled}
                onClick={() => setConfirming(true)}
                className={cn(children ? "mt-3" : undefined, BLUE_AND_SECONDARY)}
              >
                {action.label}
              </Button>
              <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{action.confirmTitle ?? action.label}</AlertDialogTitle>
                    <AlertDialogDescription>
                      Qué cambia y dónde se va a notar:
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {action.consequences.map((consequence) => (
                      <li key={consequence}>{consequence}</li>
                    ))}
                  </ul>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancelar</AlertDialogCancel>
                    <AlertDialogAction
                      type="button"
                      variant="outline"
                      className={BLUE_AND_SECONDARY}
                      onClick={() => {
                        setConfirming(false)
                        action.onClick()
                      }}
                    >
                      {action.label}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export default ConsequenceZone
