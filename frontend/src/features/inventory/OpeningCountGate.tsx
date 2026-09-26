import { ClipboardList, TriangleAlert } from "lucide-react"
import { Link, useLocation } from "react-router-dom"

import type { AreaOpeningPendingOut } from "@/api/areaCounts"
import { useSession } from "@/app/session"
import { Button } from "@/components/ui/button"

import { useConteoEncendido, useOpeningGate } from "./useOpeningGate"

/** Pantallas de estación: los tiquetes no se frenan nunca; sólo avisan en rojo. */
const ESTACION = /^\/pos\/(kds|cocina)(\/|$)/
/** La pantalla del conteo (y la raíz, que sólo redirige) no se tapan a sí mismas. */
const LIBRE = /^\/pos\/?$|^\/pos\/conteo(\/|$)/

function textoPendientes(pending: AreaOpeningPendingOut[]): string {
  return pending.map((p) => `${p.area_name} (${p.counted} de ${p.total})`).join(", ")
}

/**
 * El aviso rojo fijo del KDS: qué áreas no terminaron su conteo de apertura.
 * Va abajo y por encima de la pantalla completa del KDS (`z-50`), y nunca
 * tapa un tiquete: los tiquetes no se pueden frenar.
 */
function AvisoEstacion({ pending }: { pending: AreaOpeningPendingOut[] }): React.JSX.Element {
  return (
    <>
      <div aria-hidden="true" className="h-16" />
      <div
        role="status"
        className="fixed inset-x-0 bottom-0 z-50 flex flex-wrap items-center justify-between gap-2 bg-destructive px-4 py-3 text-destructive-foreground shadow-lg"
      >
        <p className="flex items-center gap-2 text-base font-semibold">
          <TriangleAlert aria-hidden="true" className="size-5 shrink-0" />
          Falta el conteo de apertura: {textoPendientes(pending)}
        </p>
        <Button
          variant="secondary"
          className="h-11"
          render={<Link to="/pos/conteo" />}
        >
          Ir al conteo
        </Button>
      </div>
    </>
  )
}

/**
 * **La apertura es obligatoria** (decisión 5 del dueño): a quien es de un
 * área con la apertura pendiente, las pantallas del POS le muestran «Primero
 * el conteo de apertura» en vez de la pantalla, hasta que su área tenga
 * todos los artículos contados. El KDS y la vista de cocina **no se frenan**
 * (los tiquetes no pueden parar): muestran un aviso rojo fijo. Quién queda
 * frenado lo decide el servidor (`GET /device/area-count/gate`): no el
 * supervisor, no quien no tiene área, no después de empezado el cierre.
 *
 * Si la consulta falla o todavía no llegó, la pantalla se muestra: esta
 * puerta ordena el día, no protege plata (el servidor nunca bloquea la caja
 * ni la venta por el conteo).
 */
export function OpeningCountGate({ children }: { children: React.ReactNode }): React.ReactNode {
  const { me, hasFeature } = useSession()
  const { pathname } = useLocation()
  const encendido = useConteoEncendido()
  const estacion = ESTACION.test(pathname)
  const libre = LIBRE.test(pathname)
  const hayPersona = Boolean(me?.employee)
  const gate = useOpeningGate(encendido && !libre && (estacion || hayPersona))
  const data = gate.data

  if (estacion) {
    return (
      <>
        {children}
        {data && data.pending.length > 0 ? <AvisoEstacion pending={data.pending} /> : null}
      </>
    )
  }
  if (!encendido || libre || !data?.required) return children
  return (
    <section
      aria-labelledby="puerta-apertura"
      className="mx-auto max-w-xl space-y-4 rounded-lg border-2 border-destructive bg-destructive/5 p-6 text-center"
    >
      <ClipboardList aria-hidden="true" className="mx-auto size-10 text-destructive" />
      <h2 id="puerta-apertura" className="text-2xl font-semibold">
        Primero el conteo de apertura
      </h2>
      <p className="text-base">{data.message}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="lg" className="h-12 text-base" render={<Link to="/pos/conteo" />}>
          Ir al conteo
        </Button>
        {hasFeature("kitchen.kds") ? (
          <Button size="lg" variant="outline" className="h-12 text-base" render={<Link to="/pos/kds" />}>
            Ver tiquetes de cocina
          </Button>
        ) : null}
      </div>
    </section>
  )
}
