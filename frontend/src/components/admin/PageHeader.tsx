import { CircleHelp, type LucideIcon } from "lucide-react"
import { useId, useState } from "react"

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
  /**
   * El ícono del dato, opcional. `a2` los usa para los dos que hablan de
   * tiempo —el que se refresca solo y el corte del día— y deja sin ícono al
   * que es una frase («Servicio de noche en curso — quedan 9 comandas
   * abiertas»). Es una pista, nunca la única señal: el texto ya dice lo
   * mismo, y por eso va `aria-hidden`.
   */
  icon?: LucideIcon
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
 * **La pregunta va plegada en «¿Qué es esto?»** (mapa de pantallas, regla 2:
 * «la explicación va en ¿Qué es esto?, no en la pantalla»). El dueño comparó
 * el admin con el de café-sistema y el del restaurante le pareció agobiante:
 * la primera pantalla de Hoy decía 485 palabras contra 165. La pregunta sigue
 * siendo obligatoria —quien entra por primera vez a «Rangos» la necesita—,
 * pero la lee quien la pide, no todos todas las veces. Sigue en el árbol
 * (`hidden`), así que la pantalla no cambia de qué dice, sólo de qué muestra.
 */
export function PageHeader({
  name,
  question,
  context,
  actions,
  children,
  className,
}: PageHeaderProps): React.JSX.Element {
  const [explicar, setExplicar] = useState(false)
  const idPregunta = useId()
  return (
    <header className={cn("flex flex-col gap-2", className)}>
      {/* En el celular las acciones van debajo del título: al lado, lo
          apretaban a una columna de dos palabras por renglón. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="text-2xl leading-tight font-bold">{name}</h1>
            <button
              type="button"
              aria-expanded={explicar}
              aria-controls={idPregunta}
              onClick={() => setExplicar((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <CircleHelp className="size-3.5 shrink-0" aria-hidden="true" />
              ¿Qué es esto?
            </button>
          </div>
          <p id={idPregunta} hidden={!explicar} className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
            {question}
          </p>
        </div>
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto sm:justify-end">{actions}</div>
        ) : null}
      </div>
      {context && context.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {context.map((item, i) => (
            <span key={i} className="inline-flex items-center gap-4">
              {/* El filete entre datos, como en `a2` (`.contexto .sep`): sin
                  él, «hace 14 s» y «Corte del día a las 3:00 a. m.» se leen
                  como una sola frase larga. Va entre los datos y nunca
                  antes del primero. */}
              {i > 0 ? (
                <span aria-hidden="true" className="h-3.5 w-px shrink-0 bg-border" />
              ) : null}
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={item.title}>
                {item.icon ? <item.icon className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                <span>{item.label}</span>
                {item.value !== undefined ? (
                  <b className="font-bold text-foreground">{item.value}</b>
                ) : null}
              </span>
            </span>
          ))}
        </p>
      ) : null}
      {children}
    </header>
  )
}

export default PageHeader
