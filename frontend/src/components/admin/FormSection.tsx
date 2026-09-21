import { CircleAlert, Info } from "lucide-react"
import { useId } from "react"

import { ScopeMarks, type ScopeMarksProps } from "@/components/admin/ScopeMarks"
import { cn } from "@/lib/utils"

export interface FormSectionProps {
  title: string
  /**
   * **Una línea de qué gobierna.** Obligatoria: «Con cuánto arranca el cajón
   * cada vez que alguien abre turno en Chapinero».
   */
  governs: string
  /** Los campos, en rejilla. */
  children: React.ReactNode
  /**
   * **La escala**, cuando varios campos vecinos son fronteras de la misma
   * recta: se dibuja la recta, a escala y teñida, con **las franjas leídas de
   * los campos y nunca al revés**.
   */
  scale?: React.ReactNode
  /**
   * **La lectura.** Obligatoria, y ésa es la teeth de este patrón: devuelve
   * en palabras la regla que el formulario está escribiendo, y con ella la
   * validación cruzada que ningún campo solo puede ver —que la tolerancia sin
   * causa quede por debajo de la crítica—. Un editor de umbrales sin lectura
   * es un editor que no sabe qué regla escribió.
   */
  reading: React.ReactNode
  /**
   * **Decir también lo que *no* pasa.** Un umbral suena a compuerta: «nada de
   * esto bloquea el cierre». Cuando el nombre de un control sugiere un poder
   * que no tiene, la ayuda lo desmiente.
   */
  doesNotDo?: React.ReactNode
  /** `"one"` cuando los campos son largos y la rejilla los apretaría. */
  columns?: "auto" | "one"
  id?: string
  className?: string
}

/**
 * **Sección de formulario** (`docs/PATRONES-ADMIN.md` § 9). Tarjeta con
 * título, una línea de qué gobierna, campos en rejilla, y bajo cada uno la
 * ayuda que dice **la consecuencia, no el formato**.
 *
 * La primera regla del patrón —**un campo se dibuja si alguna lógica lo
 * lee**— no la puede hacer cumplir un componente: se comprueba buscando el
 * ajuste en el *servicio*, no en el esquema. Uno que existe en el modelo, el
 * router y el tipo de API pero tiene cero usos de negocio no es un campo, es
 * un resto; dibujarle un editor le enseña al dueño una regla que el producto
 * no aplica. Queda escrito acá porque es donde se va a leer.
 *
 * Aplica a las diez secciones de Ajustes y a Fiscal, Ventas, UVT, Empleados,
 * Zonas y Funciones.
 */
export function FormSection({
  title,
  governs,
  children,
  scale,
  reading,
  doesNotDo,
  columns = "auto",
  id,
  className,
}: FormSectionProps): React.JSX.Element {
  const headingId = useId()
  return (
    <section id={id} aria-labelledby={headingId} className={cn("rounded-lg border bg-card", className)}>
      <header className="border-b bg-muted px-3 py-2.5">
        <h3 id={headingId} className="text-sm font-bold">
          {title}
        </h3>
        <p className="mt-0.5 max-w-[76ch] text-xs leading-relaxed text-muted-foreground">{governs}</p>
      </header>

      {scale ? <div className="px-3 pt-3">{scale}</div> : null}

      <div
        className={cn(
          "grid gap-x-4 gap-y-3 px-3 py-3",
          columns === "one" ? "grid-cols-1" : "sm:grid-cols-2",
        )}
      >
        {children}
      </div>

      <div className="mx-3 mb-3 rounded-md border bg-muted px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
        {reading}
      </div>

      {doesNotDo ? (
        <p className="mx-3 mb-3 flex gap-2 border-l-[3px] border-l-input pl-3 text-xs leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{doesNotDo}</span>
        </p>
      ) : null}
    </section>
  )
}

export interface FormFieldProps {
  label: string
  /**
   * **La ayuda dice la consecuencia, no el formato.** Obligatoria: «Hasta
   * este monto el cajero elige una causa pero "Sin identificar" sigue
   * sirviendo», no «número entero de pesos».
   */
  help: React.ReactNode
  /** Las marcas de alcance del campo (`ScopeMarks`, patrón 10). */
  scope?: ScopeMarksProps
  /** El error de la validación cruzada, con la acción correctiva nombrada. */
  error?: string
  /** El control. Recibe el `id` por `htmlFor`. */
  children: (ids: { fieldId: string; describedBy: string }) => React.ReactNode
  className?: string
}

/**
 * Un campo de `FormSection`, con su rótulo, su control, su ayuda y sus marcas
 * de alcance. `help` es obligatoria porque el patrón la pide bajo **cada**
 * campo, y porque la ayuda ausente es exactamente la que hace que un umbral
 * parezca una compuerta.
 */
export function FormField({
  label,
  help,
  scope,
  error,
  children,
  className,
}: FormFieldProps): React.JSX.Element {
  const fieldId = useId()
  const helpId = `${fieldId}-help`
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={fieldId} className="mb-1 block text-sm font-bold">
        {label}
      </label>
      {children({ fieldId, describedBy: helpId })}
      <p
        id={helpId}
        className={cn(
          "mt-1 text-xs leading-relaxed",
          error ? "flex gap-1.5 text-destructive" : "text-muted-foreground",
        )}
      >
        {error ? (
          <>
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </>
        ) : (
          help
        )}
      </p>
      {scope ? <ScopeMarks {...scope} /> : null}
    </div>
  )
}

export default FormSection
