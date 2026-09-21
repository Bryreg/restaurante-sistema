import { ChevronDown, CircleAlert } from "lucide-react"
import { useState } from "react"

import { FilterLink, type FilterLinkProps } from "@/components/admin/FilterLink"
import { cn } from "@/lib/utils"

export type NoticeSeverity = "critical" | "warning" | "whenever"

interface NoticeBase {
  id: string
  /** La **cifra adelante**: «5 insumos en negativo», «6 comandas atascadas». */
  title: React.ReactNode
  /** A dónde lleva, con el filtro nombrado en palabras. */
  link?: FilterLinkProps
}

/**
 * Un aviso. El crítico **tiene que decir la consecuencia** —«no bloquea la
 * venta, pero el costo del plato miente»— y por eso `consequence` es
 * obligatoria en esa rama del tipo: un aviso crítico que sólo grita no deja
 * decidir nada (`docs/PATRONES-ADMIN.md` § 7).
 */
export type Notice =
  | (NoticeBase & { severity: "critical"; consequence: React.ReactNode })
  | (NoticeBase & { severity: "warning" | "whenever"; consequence?: React.ReactNode })

export interface NoticeRailProps {
  /** El encabezado del riel. */
  title?: string
  /** Los avisos, en el orden por gravedad que manda el servidor. */
  notices: readonly Notice[]
  /** Qué se dibuja sin avisos: el «vacío bueno», que es una noticia. */
  empty?: React.ReactNode
  /** El pie: «Ordenados por gravedad». */
  footNote?: React.ReactNode
  className?: string
}

const SEVERITY_ORDER: readonly NoticeSeverity[] = ["critical", "warning", "whenever"]

const SEVERITY_LABEL: Record<NoticeSeverity, string> = {
  critical: "Crítico",
  warning: "Aviso",
  whenever: "Para cuando puedas",
}

/** El punto de gravedad de un aviso colapsado. Rojo y ámbar son ESTADO. */
const SEVERITY_DOT: Record<NoticeSeverity, string> = {
  critical: "bg-destructive",
  warning: "bg-warning",
  whenever: "bg-input",
}

/** El riel de gravedad de 3 px a la izquierda del aviso. Rojo y ámbar son ESTADO. */
const SEVERITY_EDGE: Record<NoticeSeverity, string> = {
  critical: "border-l-destructive",
  warning: "border-l-warning",
  whenever: "border-l-input",
}

/** El ícono de gravedad, y su color. */
const SEVERITY_ICON: Record<NoticeSeverity, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  whenever: "text-muted-foreground",
}

/**
 * **Un aviso, siempre desplegado**: título con la cifra adelante, una línea
 * de por qué duele, y el destino nombrado abajo.
 *
 * Antes el crítico iba desplegado y el resto colapsaba a una línea, con el
 * detalle apagado corriendo dentro del mismo renglón. La maqueta `a2` los
 * escribe todos con la misma forma (`.av`) y distingue la gravedad por el
 * **riel de color a la izquierda** y el ícono, no por la forma: a tres
 * columnas de texto, dos formas distintas hacían que la mitad de los avisos
 * pareciera un pie de página de la otra mitad. El teñido de fondo del
 * crítico también se va —`a2` deja el papel blanco y sólo colorea el
 * riel—: con tres críticos seguidos, el bloque rosado se leía como un
 * estado de error de la pantalla entera.
 */
function NoticeItem({ notice }: { notice: Notice }): React.JSX.Element {
  return (
    <li
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] gap-2.5 border-t border-l-[3px] px-3 py-2",
        SEVERITY_EDGE[notice.severity],
      )}
    >
      <CircleAlert
        className={cn("mt-0.5 size-4 shrink-0", SEVERITY_ICON[notice.severity])}
        aria-hidden="true"
      />
      <div className="min-w-0">
        <p className="text-sm leading-snug font-bold">{notice.title}</p>
        {notice.consequence ? (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{notice.consequence}</p>
        ) : null}
        {notice.link ? <FilterLink {...notice.link} className="mt-1.5" /> : null}
      </div>
    </li>
  )
}

function GroupHeading({ severity, count }: { severity: NoticeSeverity; count: number }): React.JSX.Element {
  return (
    <p className="flex items-center gap-2 border-t px-3 pt-2.5 pb-1 text-[0.65rem] tracking-widest text-muted-foreground uppercase first:border-t-0">
      <span
        aria-hidden="true"
        className={cn("size-[7px] shrink-0 rounded-full", SEVERITY_DOT[severity])}
      />
      {SEVERITY_LABEL[severity]}
      <b className="ml-auto text-xs font-bold tracking-normal text-foreground tabular-nums">{count}</b>
    </p>
  )
}

/**
 * **Aviso accionable y su riel** (`docs/PATRONES-ADMIN.md` § 7). El patrón
 * más caro del rediseño: lo urgente estaba último, bajo el pliegue, en doce
 * tarjetas iguales a dos columnas.
 *
 * Una columna pegada a la derecha, siempre visible, con **encabezado de
 * gravedad y recuento**. El recuento se **deriva** de `notices`: no es una
 * prop, y por lo tanto no puede mentir. Los críticos van desplegados, el
 * resto colapsa a una línea, y la cola sin urgencia se pliega.
 *
 * Aplica a Notificaciones, Salud del control, Devoluciones pendientes y a
 * cualquier lista de pendientes.
 */
export function NoticeRail({
  title = "Requiere tu atención",
  notices,
  empty,
  footNote,
  className,
}: NoticeRailProps): React.JSX.Element {
  const [foldedOpen, setFoldedOpen] = useState(false)

  const bySeverity = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: notices.filter((n) => n.severity === severity),
  })).filter((g) => g.items.length > 0)

  const whenever = notices.filter((n) => n.severity === "whenever")

  return (
    <aside
      aria-label={title}
      className={cn("sticky top-4 self-start rounded-lg border bg-card", className)}
    >
      {/* El filete bajo el título, como en `a2` (`.tarjeta-tit`): sin él el
          encabezado del riel y el de la primera gravedad se leían como dos
          renglones del mismo rótulo. */}
      <div className="flex items-center gap-2 border-b px-3 py-2.5">
        <h2 className="text-[0.7rem] tracking-wider text-muted-foreground uppercase">{title}</h2>
        <b className="ml-auto text-sm font-bold tabular-nums">{notices.length}</b>
      </div>

      {notices.length === 0 ? (
        <div className="px-3 pb-3">{empty}</div>
      ) : (
        bySeverity.map((group) => (
          <div key={group.severity}>
            {/* La cola sin urgencia **no lleva encabezado de grupo**: `a2` la
                deja como un solo renglón plegado al pie del riel
                (`.av-pie`). Un encabezado «PARA CUANDO PUEDAS 3» seguido de
                un botón que dice «3 avisos más, sin urgencia» decía el mismo
                número dos veces en dos renglones. */}
            {group.severity === "whenever" ? null : (
              <GroupHeading severity={group.severity} count={group.items.length} />
            )}
            {group.severity === "whenever" ? (
              <>
                <button
                  type="button"
                  aria-expanded={foldedOpen}
                  onClick={() => setFoldedOpen((open) => !open)}
                  className="flex w-full items-center gap-2 rounded-b-lg border-t bg-muted px-3 py-2 text-left text-sm font-bold text-primary hover:bg-accent"
                >
                  {whenever.length} {whenever.length === 1 ? "aviso más" : "avisos más"}, sin urgencia
                  <ChevronDown
                    aria-hidden="true"
                    className={cn("ml-auto size-4 transition-transform", foldedOpen && "rotate-180")}
                  />
                </button>
                {foldedOpen ? (
                  <ul>
                    {group.items.map((notice) => (
                      <NoticeItem key={notice.id} notice={notice} />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <ul>
                {group.items.map((notice) => (
                  <NoticeItem key={notice.id} notice={notice} />
                ))}
              </ul>
            )}
          </div>
        ))
      )}

      {footNote ? (
        <p className="border-t px-3 py-2 text-right text-xs text-muted-foreground">{footNote}</p>
      ) : null}
    </aside>
  )
}

export default NoticeRail
