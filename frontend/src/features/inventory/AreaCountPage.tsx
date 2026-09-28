import { useState } from "react"
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom"

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
  const navigate = useNavigate()
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
    <div className="mx-auto flex max-w-[820px] flex-col gap-3">
      {/* El título visible es el del panel («Conteo de apertura», handoff
          POS pantalla 7); éste nombra la pantalla para lectores de pantalla. */}
      <h1 className="sr-only">Conteo por área</h1>
      {termino ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border-2 border-success/70 bg-success/5 p-4">
          <p className="text-[17px] font-semibold">Listo el conteo de apertura de tu área.</p>
          <Button size="lg" className="h-[56px] rounded-[12px] px-5 text-[17px]" render={<Link to={siguiente} replace />}>
            Seguir
          </Button>
        </div>
      ) : null}
      <AreaCountPanel onTerminar={() => navigate(siguiente, { replace: true })} />
    </div>
  )
}

export default AreaCountPage
