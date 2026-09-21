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
