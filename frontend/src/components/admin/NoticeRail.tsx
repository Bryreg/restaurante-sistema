import { ChevronDown } from "lucide-react"
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
  /**
   * La plata en juego, **ya formateada** por quien llama («$ 1.500.506»,
   * «−$ 68.000 faltante»): va a la derecha del título para que el riel se
   * lea también por tamaño. Opcional: un aviso que no es de plata no la
   * lleva (nunca «$ 0»). El orden lo decide quien arma `notices`.
   */
  amount?: React.ReactNode
  /**
   * Lo que se resuelve **en el mismo lugar** (handoff, `AdminHoy` variante
   * A): «Confirmar consignación / No coincide», «Aprobar / Rechazar», la
   * foto del comprobante, y una vez resuelto el rastro «✓ Confirmada por ti
   * · 12:55 p. m.» con «Reversar con motivo». Va debajo de la consecuencia y
   * antes del destino. Quien llama arma los controles; el riel sólo les da
   * lugar.
   */
  actions?: React.ReactNode
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
  /**
   * Cuántos avisos urgentes (críticos y de atención, en ese orden) se ven de
   * entrada, en cualquier ancho; el resto queda detrás de un solo «Ver n
   * más». Sin `limit`, el corte es el del celular de siempre: los críticos
   * enteros y tres de atención. Los recuentos del encabezado y de cada
   * gravedad siguen diciendo cuántos hay, no cuántos se ven.
   */
  limit?: number
  className?: string
}

const SEVERITY_ORDER: readonly NoticeSeverity[] = ["critical", "warning", "whenever"]

const SEVERITY_LABEL: Record<NoticeSeverity, string> = {
  critical: "Crítico",
  warning: "Atención",
  whenever: "Cuando puedas",
}

/** El color del rótulo de cada gravedad. Rojo y ámbar son ESTADO. */
const SEVERITY_TEXT: Record<NoticeSeverity, string> = {
  critical: "text-destructive",
  warning: "text-warning",
  whenever: "text-muted-foreground",
}

/** La forma de cada gravedad (■ ▲ ●): el color nunca es la única señal. */
const SEVERITY_SHAPE: Record<NoticeSeverity, string> = {
  critical: "rounded-[1px]",
  warning: "[clip-path:polygon(50%_0,100%_100%,0_100%)]",
  whenever: "rounded-[1px]",
}

/**
 * **Un aviso, siempre desplegado**: título con la cifra adelante, una línea
 * de por qué duele, y el destino nombrado abajo. En el estilo «Burbujas» cada
 * aviso es un pozo de radio 18 dentro de la burbuja del riel; la gravedad la
 * dice el rótulo del grupo, con su color y su forma.
 */
function NoticeItem({ notice, className }: { notice: Notice; className?: string }): React.JSX.Element {
  return (
    <li className={cn("rounded-[18px] bg-muted px-3.5 py-3", className)} data-severity={notice.severity}>
      {notice.amount !== undefined && notice.amount !== null ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p className="min-w-0 text-sm leading-snug font-semibold">{notice.title}</p>
          <p className="shrink-0 text-sm font-semibold whitespace-nowrap tabular-nums" data-notice-amount="">
            {notice.amount}
          </p>
        </div>
      ) : (
        <p className="text-sm leading-snug font-semibold">{notice.title}</p>
      )}
      {notice.consequence ? (
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{notice.consequence}</p>
      ) : null}
      {notice.actions ? <div className="mt-2.5 flex flex-col gap-2">{notice.actions}</div> : null}
      {notice.link ? <FilterLink {...notice.link} className="mt-2" /> : null}
    </li>
  )
}

/** Cuántos avisos de atención se ven en el celular antes de «Ver N más». */
const PHONE_WARNING_LIMIT = 3

/** El lugar de un aviso entre los urgentes: críticos primero, después los de atención. */
function posicionUrgente(notices: readonly Notice[], notice: Notice): number {
  const urgentes = [
    ...notices.filter((n) => n.severity === "critical"),
    ...notices.filter((n) => n.severity === "warning"),
  ]
  return urgentes.indexOf(notice)
}

/** La última gravedad urgente con avisos: al pie de ella va «Ver n más». */
function lastUrgent(groups: readonly { severity: NoticeSeverity }[]): NoticeSeverity | undefined {
  return [...groups].reverse().find((g) => g.severity !== "whenever")?.severity
}

function GroupHeading({ severity, count }: { severity: NoticeSeverity; count: number }): React.JSX.Element {
  return (
    <p className={cn("flex items-center gap-2 px-1 pt-3 pb-2 text-xs font-semibold", SEVERITY_TEXT[severity])}>
      <span aria-hidden="true" className={cn("size-[7px] shrink-0 bg-current", SEVERITY_SHAPE[severity])} />
      {SEVERITY_LABEL[severity]}
      <b className="ml-auto text-xs font-semibold text-muted-foreground tabular-nums">{count}</b>
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
  limit,
  className,
}: NoticeRailProps): React.JSX.Element {
  const [foldedOpen, setFoldedOpen] = useState(false)
  const [warningsOpen, setWarningsOpen] = useState(false)
  const urgentes = notices.filter((n) => n.severity !== "whenever").length
  const ocultos = limit === undefined || warningsOpen ? 0 : Math.max(0, urgentes - limit)

  const bySeverity = SEVERITY_ORDER.map((severity) => ({
    severity,
    items: notices.filter((n) => n.severity === severity),
  })).filter((g) => g.items.length > 0)

  const whenever = notices.filter((n) => n.severity === "whenever")

  return (
    <aside
      aria-label={title}
      // «Burbujas»: el riel es una burbuja; cada aviso, un pozo.
      className={cn("burbuja sticky top-4 self-start rounded-[24px] bg-card p-5", className)}
    >
      <div className="flex items-center gap-2 px-1 pb-1">
        <h2 className="text-[17px] font-semibold tracking-normal">{title}</h2>
        <b className="ml-auto grid h-6 min-w-6 place-items-center rounded-full bg-foreground px-2 text-xs font-semibold text-card tabular-nums">
          {notices.length}
        </b>
      </div>

      {notices.length === 0 ? (
        <div className="pt-2">{empty}</div>
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
                  className="mt-3 flex min-h-10 w-full items-center gap-2 rounded-full bg-muted px-4 text-left text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  {whenever.length} {whenever.length === 1 ? "aviso más" : "avisos más"}, sin urgencia
                  <ChevronDown
                    aria-hidden="true"
                    className={cn("ml-auto size-4 transition-transform", foldedOpen && "rotate-180")}
                  />
                </button>
                {foldedOpen ? (
                  <ul className="mt-2 flex flex-col gap-2">
                    {group.items.map((notice) => (
                      <NoticeItem key={notice.id} notice={notice} />
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <>
                <ul className="flex flex-col gap-2">
                  {group.items.map((notice, i) => (
                    <NoticeItem
                      key={notice.id}
                      notice={notice}
                      className={
                        limit !== undefined
                          ? // Con `limit`, el corte es el mismo en todo ancho y
                            // cuenta los críticos antes que los de atención.
                            !warningsOpen && posicionUrgente(notices, notice) >= limit
                            ? "hidden"
                            : undefined
                          : // En el celular los de atención se cortan en los
                            // primeros: el dueño lee esto en un minuto, y con
                            // quince avisos la cifra y los indicadores quedaban
                            // pantallas abajo. Los críticos nunca se cortan.
                            group.severity === "warning" && i >= PHONE_WARNING_LIMIT && !warningsOpen
                            ? "max-md:hidden"
                            : undefined
                      }
                    />
                  ))}
                </ul>
                {limit !== undefined && group.severity === lastUrgent(bySeverity) && (ocultos > 0 || (warningsOpen && urgentes > limit)) ? (
                  <button
                    type="button"
                    aria-expanded={warningsOpen}
                    onClick={() => setWarningsOpen((open) => !open)}
                    className="mt-2 flex min-h-10 w-full items-center gap-2 rounded-full bg-muted px-4 text-left text-sm font-semibold text-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    {warningsOpen ? "Ver menos" : `Ver ${ocultos} más`}
                    <ChevronDown
                      aria-hidden="true"
                      className={cn("ml-auto size-4 transition-transform", warningsOpen && "rotate-180")}
                    />
                  </button>
                ) : null}
                {limit === undefined && group.severity === "warning" && group.items.length > PHONE_WARNING_LIMIT && !warningsOpen ? (
                  <button
                    type="button"
                    onClick={() => setWarningsOpen(true)}
                    className="mt-2 flex min-h-11 w-full items-center rounded-full bg-muted px-4 text-left text-sm font-semibold text-foreground hover:bg-accent md:hidden"
                  >
                    Ver {group.items.length - PHONE_WARNING_LIMIT} más de atención
                  </button>
                ) : null}
              </>
            )}
          </div>
        ))
      )}

      {footNote ? (
        <p className="px-1 pt-3 text-xs text-muted-foreground">{footNote}</p>
      ) : null}
    </aside>
  )
}

export default NoticeRail
