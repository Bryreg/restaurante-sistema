/**
 * Ningún rediseño pierde un control sin que alguien lo decida.
 *
 * La base (`censo-controles.json`) se tomó del código ANTES de aplicar los
 * patrones del admin (`docs/PATRONES-ADMIN.md`). Cada vez que una pantalla se
 * rediseña, este test compara lo que hay contra esa base y **falla nombrando
 * el rótulo que desapareció y de qué archivo**.
 *
 * Agregar no falla: un rediseño suma controles y los reagrupa, y eso está
 * bien. Quitar sí falla. Si el rótulo cambió a propósito —se renombró, se
 * movió a otro archivo, se unificó con otro— se regenera la base:
 *
 *     npx tsx src/audit/regenerar-censo.ts
 *
 * y el cambio queda en el diff, que es donde una pérdida deliberada tiene que
 * poder discutirse. Lo que no puede pasar es que desaparezca en silencio.
 *
 * ---
 *
 * **Bajas declaradas · «Hoy» tal cual la maqueta `a2`.** Tres rótulos de
 * `features/reports/TodayPage.tsx` se sacaron a mano de la base, uno por uno
 * y no regenerándola entera: la base es lo que había **antes** del rediseño,
 * y volver a tomarla hoy la re-ancla en 128 archivos de una sola vez y tapa
 * lo que todavía protege. Los tres, con su motivo:
 *
 * - «Del día» y «Ahora mismo» — eran los dos rótulos de grupo que partían
 *   los indicadores en 4 + 3. `a2` dibuja **una sola grilla de ocho**
 *   (`.kpis`; su catálogo de patrones lo dice literal: «En Hoy, ocho»), y con
 *   el rótulo de grupo la segunda fila quedaba coja. Lo que decían —qué ya
 *   está cerrado y qué sigue vivo— lo sigue diciendo el pie de cada tarjeta.
 *   Ninguno era un control: eran encabezados.
 * - «Propinas de hoy — no son venta» — era el renglón de abajo de la raya de
 *   la banda de cifra. La propina pasó a ser la **octava tarjeta**, que es
 *   donde `a2` la pone, y sigue rotulada como que no es venta del
 *   restaurante (Ley 1935 de 2018): la cifra rectora sigue sin incluirla.
 *
 * «Día operativo» **no** se dio de baja aunque salió de la franja de
 * contexto: viaja como `title` de la pastilla de fecha de la cabecera, que
 * es el control que lo reemplazó.
 *
 * **Bajas declaradas · «Orden y aire».** El dueño comparó el admin con el de
 * café-sistema y lo encontró agobiante; el mapa de pantallas que aprobó pide
 * sacar de la vista el texto que explica en vez de dar un dato. Salen de la
 * base, a mano y una por una, sólo frases que el censo levantaba porque
 * viajaban en un `label:`/`title=` pero que **no eran controles**:
 *
 * - «Seis pestañas: dos de consignaciones y cuatro del libro del banco.»
 *   (`features/banking/BankingAdminPage.tsx`) — describía la fila de
 *   pestañas, que ahora son tres y «Más».
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { censarArchivo, perdidos, type Censo } from "./censo"
import base from "./censo-controles.json"

const SRC = join(__dirname, "..")

function censoActual(archivos: string[]): Censo {
  const censo: Censo = {}
  for (const rel of archivos) {
    try {
      censo[rel] = censarArchivo(readFileSync(join(SRC, rel), "utf8"))
    } catch {
      censo[rel] = [] // el archivo se borró: todos sus rótulos cuentan como perdidos
    }
  }
  return censo
}

describe("censo de controles", () => {
  const archivos = Object.keys(base as Censo)

  it("la base no está vacía (si lo estuviera, este test no protegería nada)", () => {
    const total = Object.values(base as Censo).reduce((n, r) => n + r.length, 0)
    expect(archivos.length).toBeGreaterThan(20)
    expect(total).toBeGreaterThan(200)
  })

  it("ninguna pantalla perdió un control", () => {
    const faltan = perdidos(base as Censo, censoActual(archivos))
    const detalle = Object.entries(faltan)
      .map(([archivo, rotulos]) => `  ${archivo}\n${rotulos.map((r) => `      · «${r}»`).join("\n")}`)
      .join("\n")

    expect(
      faltan,
      `desaparecieron controles que la base tenía:\n${detalle}\n\n` +
        `Si es a propósito —se renombró, se movió, se unificó— regenerá la base con\n` +
        `  npx tsx src/audit/regenerar-censo.ts\n` +
        `y que el diff lo muestre. Si no lo es, el rediseño se comió un botón.`,
    ).toEqual({})
  })
})
