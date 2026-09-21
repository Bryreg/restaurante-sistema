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

/** El aviso crítico va desplegado: cifra adelante, consecuencia en el cuerpo. */
function CriticalNotice({ notice }: { notice: Notice }): React.JSX.Element {
  return (
    <li className="border-t border-l-[3px] border-l-destructive bg-destructive/5 px-3 py-2.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2.5">
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm leading-snug font-bold text-destructive">{notice.title}</p>
          {notice.consequence ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{notice.consequence}</p>
          ) : null}
          {notice.link ? <FilterLink {...notice.link} className="mt-1.5" /> : null}
        </div>
      </div>
    </li>
  )
}

/**
 * El aviso no crítico colapsa a **una línea**. Los dos niveles son lo que
 * deja escalar de 0 a 14 sin cambiar de forma: doce tarjetas iguales a dos
 * columnas pierden el orden por gravedad en el zigzag.
 */
function CollapsedNotice({ notice }: { notice: Notice }): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-t px-3 py-2 text-sm">
      <span
        aria-hidden="true"
        className={cn("relative -top-px size-[7px] shrink-0 rounded-full", SEVERITY_DOT[notice.severity])}
      />
      <span className="min-w-0 flex-[1_1_58%]">{notice.title}</span>
      {notice.link ? <FilterLink {...notice.link} className="shrink-0" /> : null}
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
      <div className="flex items-center gap-2 px-3 py-2.5">
        <h2 className="text-[0.7rem] tracking-wider text-muted-foreground uppercase">{title}</h2>
        <b className="ml-auto text-sm font-bold tabular-nums">{notices.length}</b>
      </div>

      {notices.length === 0 ? (
        <div className="px-3 pb-3">{empty}</div>
      ) : (
        bySeverity.map((group) => (
          <div key={group.severity}>
            <GroupHeading severity={group.severity} count={group.items.length} />
            {group.severity === "whenever" ? (
              <>
                <button
                  type="button"
                  aria-expanded={foldedOpen}
                  onClick={() => setFoldedOpen((open) => !open)}
                  className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-sm text-primary hover:bg-muted"
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
                      <CollapsedNotice key={notice.id} notice={notice} />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <ul>
                {group.items.map((notice) =>
                  notice.severity === "critical" ? (
                    <CriticalNotice key={notice.id} notice={notice} />
                  ) : (
                    <CollapsedNotice key={notice.id} notice={notice} />
                  ),
                )}
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
