import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")

/** Este mismo archivo queda afuera: contiene, como texto, justamente los
 * patrones que busca, y si no se excluye se caza a sí mismo. */
const YO = path.basename(__filename)

function archivosDeTest(dir: string, acc: string[] = []): string[] {
  for (const nombre of readdirSync(dir)) {
    const p = path.join(dir, nombre)
    if (statSync(p).isDirectory()) archivosDeTest(p, acc)
    else if (/\.test\.tsx?$/.test(nombre) && nombre !== YO) acc.push(p)
  }
  return acc
}

/**
 * Cuatro veces en este proyecto un test pasó aislado y falló en la suite
 * completa por la misma razón: preguntar en SÍNCRONO por una opción de un
 * `Select` cuyo popup vive en un portal. Con casi cien entornos jsdom
 * compitiendo por CPU, el popup todavía no está montado cuando
 * `getByRole("option")` pregunta.
 *
 * Un verde que depende de la carga de la máquina es peor que un rojo:
 * enseña a ignorar el rojo de la suite y a repetir la corrida hasta que
 * salga bien. Esto lo cobra de entrada.
 *
 * `getAllByRole("option")` se permite SI antes hay un `findByRole("option")`
 * en el mismo test: esperar una opción concreta y después listarlas todas es
 * el patrón correcto.
 */
describe("los tests no preguntan en síncrono por un popup que vive en un portal", () => {
  it('ninguno usa `screen.getByRole("option")`: sobre un portal hay que esperar', () => {
    const malos: string[] = []
    for (const archivo of archivosDeTest(SRC)) {
      const texto = readFileSync(archivo, "utf8")
      texto.split("\n").forEach((linea, i) => {
        if (/screen\.getByRole\(\s*["']option["']/.test(linea)) {
          malos.push(`${path.relative(SRC, archivo)}:${i + 1}`)
        }
      })
    }
    expect(
      malos,
      "estos tests preguntan por una opción sin esperarla, así que pasan solos y fallan en la suite " +
        "completa según cómo ande la máquina:\n" + malos.join("\n") + "\nUsá `await screen.findByRole(\"option\", …)`",
    ).toEqual([])
  })

  it('un `getAllByRole("option")` viene siempre precedido de un `findByRole("option")` en el mismo test', () => {
    const malos: string[] = []
    for (const archivo of archivosDeTest(SRC)) {
      const texto = readFileSync(archivo, "utf8")
      // Cada bloque `it(` es un test; se mira dentro de cada uno por separado.
      for (const bloque of texto.split(/\n\s*it\(/)) {
        if (!/getAllByRole\(\s*["']option["']/.test(bloque)) continue
        const iEspera = bloque.search(/findByRole\(\s*["']option["']/)
        const iListado = bloque.search(/getAllByRole\(\s*["']option["']/)
        if (iEspera === -1 || iEspera > iListado) {
          const titulo = bloque.split("\n")[0].slice(0, 70)
          malos.push(`${path.relative(SRC, archivo)} → ${titulo}`)
        }
      }
    }
    expect(
      malos,
      "estos listan las opciones de un portal sin esperar ninguna primero:\n" + malos.join("\n"),
    ).toEqual([])
  })
})
