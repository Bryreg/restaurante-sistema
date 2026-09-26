import { useState } from "react"
import { Link, Navigate, useSearchParams } from "react-router-dom"

import { inicioParaPuesto } from "@/app/puesto"
import { useSession } from "@/app/session"
import { Button } from "@/components/ui/button"

import { AreaCountPanel } from "./AreaCountPanel"
import { useConteoEncendido, useOpeningGate } from "./useOpeningGate"

/**
 * `/pos/conteo`: la pantalla de conteo por área como pantalla propia del
 * POS, sin caja abierta de por medio. Cocina y bar llegan acá después del
 * PIN (`inicioParaPuesto`, con `?inicio=1`): si a la persona no le falta la
 * apertura de su área, sigue sola a su pantalla de siempre (el KDS); si le
 * falta, se queda, y cuando la termina aparece «Seguir».
 */
export function AreaCountPage(): React.JSX.Element {
  const { me, hasFeature } = useSession()
  const [params] = useSearchParams()
  const inicio = params.get("inicio") === "1"
  const encendido = useConteoEncendido()
  const gate = useOpeningGate(encendido && inicio)
  const siguiente = inicioParaPuesto(me?.employee, hasFeature, { sinConteo: true })
  // Se decide con la PRIMERA respuesta: si al llegar no faltaba nada, se
  // sigue de largo; si faltaba, la persona se queda aunque termine (puede
  // querer ayudar a otra área) y se le ofrece seguir.
  const [primera, setPrimera] = useState<boolean | null>(null)
  if (inicio && primera === null && (gate.data || gate.isError)) {
    setPrimera(gate.data?.required ?? false)
  }

  if (inicio && (!encendido || primera === false)) {
    return <Navigate to={siguiente} replace />
  }
  const termino = inicio && primera === true && gate.data?.required === false

  return (
    <div className="space-y-4">
      <h2 className="text-2xl font-semibold">Conteo por área</h2>
      {termino ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-success/70 bg-success/5 p-4">
          <p className="text-base font-semibold">Listo el conteo de apertura de tu área.</p>
          <Button size="lg" className="h-12 text-base" render={<Link to={siguiente} replace />}>
            Seguir
          </Button>
        </div>
      ) : null}
      <AreaCountPanel />
    </div>
  )
}

export default AreaCountPage
