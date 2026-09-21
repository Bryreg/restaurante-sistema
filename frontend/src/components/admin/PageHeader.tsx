import { cn } from "@/lib/utils"

/**
 * Un dato de la franja de contexto: **lo que caduca**. Se dibuja el valor
 * resaltado y, si hay una marca de tiempo completa, va en `title` — la franja
 * dice «hace 14 s» y el `title` dice el instante exacto
 * (`docs/PATRONES-ADMIN.md` § 2 y § 8).
 */
export interface PageContextItem {
  label: React.ReactNode
  value?: React.ReactNode
  /** La marca de tiempo completa, o la aclaración larga. */
  title?: string
}

export interface PageHeaderProps {
  /** El nombre de la pantalla: «Hoy», «Inventario», «Ajustes · Caja». */
  name: string
  /**
   * **La pregunta que la pantalla contesta.** Obligatoria, y ésa es toda la
   * gracia del patrón: pantallas llamadas «Dinero», «Rangos» o «UVT» no se
   * explican solas, y un `h1` suelto no dice contra qué datos se mira
   * (`docs/PATRONES-ADMIN.md` § 2).
   */
  question: string
  /**
   * La franja de contexto, con lo que caduca: «se actualiza sola cada 30 s ·
   * hace 14 s», «47 activos · 6 inactivos · último conteo hace 43 días»,
   * «aplica a Chapinero · último cambio: quién y cuándo».
   */
  context?: readonly PageContextItem[]
  /**
   * Acciones y **período** a la derecha. El período vive acá y no en una barra
   * superior porque el alcance se lee por dónde vive el control (§ 1): la
   * sede está en la cabeza de la lateral, el período en la cabecera de
   * pantalla, lo que filtra una tabla en la barra de esa tabla.
   *
   * Con pestañas, **la acción primaria baja a la barra de la tabla** y acá
   * quedan sólo el período y las acciones de pantalla.
   */
  actions?: React.ReactNode
  /** Las pestañas de la pantalla, debajo de la franja de contexto. */
  children?: React.ReactNode
  className?: string
}

/**
 * **Cabecera de pantalla** (`docs/PATRONES-ADMIN.md` § 2). Aplica a las 24.
 *
 * No hay barra superior de producto: una barra superior le cobra 56 px de
 * alto a un portátil, donde el eje escaso es el vertical. Todo lo que una
 * barra superior haría vive acá o en la lateral.
 */
export function PageHeader({
  name,
  question,
  context,
  actions,
  children,
  className,
}: PageHeaderProps): React.JSX.Element {
  return (
    <header className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl leading-tight font-bold">{name}</h1>
          <p className="mt-0.5 max-w-[68ch] text-sm text-muted-foreground">{question}</p>
        </div>
        {actions ? (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
        ) : null}
      </div>
      {context && context.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {context.map((item, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
              title={item.title}
            >
              <span>{item.label}</span>
              {item.value !== undefined ? (
                <b className="font-bold text-foreground">{item.value}</b>
              ) : null}
            </span>
          ))}
        </p>
      ) : null}
      {children}
    </header>
  )
}

export default PageHeader
