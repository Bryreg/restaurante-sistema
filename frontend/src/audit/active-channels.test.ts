import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")
const ORDERS_SERVICE = path.resolve(SRC, "../../backend/app/orders/service.py")

/**
 * «Canales activos» es configuración de sede (SPEC-NEGOCIO §9.3) y son DOS
 * interruptores distintos a propósito: la función dice si el plan incluye la
 * capacidad, «canales activos» dice si esta sede la usa.
 *
 * Los dos lados tienen que coincidir, y se rompió en las dos direcciones a la
 * vez: el servidor exigía `counter` y la pantalla no lo ofrecía —error que
 * manda a una Configuración donde no se puede arreglar—, y la pantalla
 * ofrecía «Domicilio» mientras el servidor ni la miraba, o sea una casilla de
 * adorno.
 *
 * Este invariante LEE la guarda real de `create_order` en vez de repetir una
 * lista a mano, que es lo que se separó seis veces en este proyecto.
 */
describe("los canales que el servidor gatea son exactamente los que la pantalla ofrece", () => {
  it("ninguno se exige sin poder activarse, y ninguno se ofrece sin que el servidor lo mire", () => {
    const service = readFileSync(ORDERS_SERVICE, "utf8")
    const bloque = /if channel in \(\s*([\s\S]*?)\):\s*\n\s*if channel\.value not in \(store\.active_channels/.exec(service)
    expect(bloque, "no pude leer la guarda de canales de `create_order`").not.toBeNull()
    const backend = [...bloque![1].matchAll(/OrderChannel\.([A-Z_]+)/g)].map((m) => m[1].toLowerCase()).sort()
    expect(
      backend.length,
      "el barrido leyó menos de tres canales: cambió la forma de la guarda y esto se volvió un falso verde",
    ).toBeGreaterThanOrEqual(3)

    const dialog = readFileSync(path.join(SRC, "features/settings/StoreFormDialog.tsx"), "utf8")
    const lista = /const CHANNELS = \[([\s\S]*?)\]/.exec(dialog)
    expect(lista, "no pude leer `CHANNELS` de StoreFormDialog.tsx").not.toBeNull()
    const pantalla = [...lista![1].matchAll(/value:\s*"([a-z_]+)"/g)].map((m) => m[1]).sort()

    const sinCasilla = backend.filter((c) => !pantalla.includes(c))
    const deAdorno = pantalla.filter((c) => !backend.includes(c))

    expect(
      sinCasilla,
      "`create_order` exige estos canales contra `active_channels` y Configuración no los ofrece, así que " +
        "el error «activalo en Configuración» manda a una pantalla donde no se puede:\n" + sinCasilla.join("\n"),
    ).toEqual([])
    expect(
      deAdorno,
      "Configuración ofrece estos canales y el servidor no los mira: el administrador los tilda y no pasa " +
        "nada:\n" + deAdorno.join("\n"),
    ).toEqual([])
  })
})
