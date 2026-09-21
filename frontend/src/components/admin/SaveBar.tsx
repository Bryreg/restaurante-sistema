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

export interface PendingChange {
  /** El campo, en palabras: «Diferencia crítica». */
  field: string
  /** El valor viejo, ya formateado. Se dibuja tachado. */
  from: string
  /** El valor nuevo, ya formateado. */
  to: string
  /**
   * Si el cambio **sale de esta pantalla**, dónde se nota: «Cambia Salón ›
   * Cierre de turno, paso 2». La barra lo nombra sin que haya que abrir el
   * diálogo, porque es lo único que el dueño no puede adivinar.
   */
  leaks?: string
}

export interface SaveBarProps {
  /** Los cambios pendientes. Vacío es un estado, no una ausencia. */
  changes: readonly PendingChange[]
  /** Qué sección se guarda: «Caja». Se guarda **por sección, no por campo**. */
  sectionName: string
  onSave: () => void
  onDiscard: () => void
  saving?: boolean
  className?: string
}

/**
 * **Barra de guardado** (`docs/PATRONES-ADMIN.md` § 12). Pegada abajo y **no
 * desaparece**: sin cambios dice «Sin cambios» con el botón apagado, que es
 * lo que le enseña al dueño que esta pantalla se guarda, y que se guarda por
 * sección y no por campo.
 *
 * No hay prop para esconderla. Un `changes` vacío dibuja el estado de reposo;
 * una barra que aparece al primer cambio es una barra que nunca enseñó que la
 * pantalla se guardaba.
 *
 * Aplica a las diez secciones de Ajustes, Fiscal, Funciones, Empleados y Zonas.
 */
export function SaveBar({
  changes,
  sectionName,
  onSave,
  onDiscard,
  saving = false,
  className,
}: SaveBarProps): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const count = changes.length
  const leaking = changes.filter((change) => change.leaks)

  return (
    <div
      className={cn(
        "sticky bottom-3 z-[2] flex flex-wrap items-center gap-3 rounded-lg border border-input bg-card px-3 py-2.5 shadow-lg",
        className,
      )}
    >
      <p className="min-w-0 text-xs text-muted-foreground">
        {count === 0 ? (
          <>
            <b className="font-bold text-foreground">Sin cambios</b> — lo que se ve es lo que está
            guardado.
          </>
        ) : (
          <>
            <b className="font-bold text-foreground tabular-nums">{count}</b>{" "}
            {count === 1 ? "cambio sin guardar" : "cambios sin guardar"} en{" "}
            <b className="font-bold text-foreground">{sectionName}</b>
            {leaking.length > 0 ? (
              <>
                {" "}
                · <b className="font-bold text-foreground">{leaking[0].field}</b> {leaking[0].leaks}
              </>
            ) : null}
          </>
        )}
      </p>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" disabled={count === 0 || saving} onClick={onDiscard}>
          Descartar
        </Button>
        <Button type="button" disabled={count === 0 || saving} onClick={() => setConfirming(true)}>
          {saving ? "Guardando…" : "Guardar"}
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Guardar {sectionName}</AlertDialogTitle>
            <AlertDialogDescription>
              {count === 1 ? "Este cambio" : `Estos ${count} cambios`} se van a guardar:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="text-sm">
            {changes.map((change) => (
              <li key={change.field} className="flex flex-wrap items-baseline gap-2 border-b py-2 last:border-b-0">
                <span className="min-w-0">
                  {change.field}
                  {change.leaks ? (
                    <small className="mt-0.5 block text-xs text-muted-foreground">{change.leaks}</small>
                  ) : null}
                </span>
                <span className="ml-auto whitespace-nowrap tabular-nums">
                  <s className="text-muted-foreground">{change.from}</s> → {change.to}
                </span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              type="button"
              onClick={() => {
                setConfirming(false)
                onSave()
              }}
            >
              Guardar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export default SaveBar
