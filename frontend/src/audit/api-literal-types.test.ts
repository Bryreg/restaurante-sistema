/**
 * Los valores que el cliente cree que existen son los que el servidor publica.
 *
 * Nace de un defecto real del recorrido en navegador de la fase 3: el cliente
 * declaraba `export type SettlementStatus = "pending" | "matched" | "reversed"`
 * y el servidor publica `recorded | matched | reversed`. Como `"pending"` no
 * existe nunca, la pantalla comparaba contra un valor imposible y **el botón
 * «Conciliar» no se renderizaba jamás**. La capacidad entera quedaba muerta.
 *
 * `tsc` no lo ve —los dos lados son literales válidos, cada uno en su
 * lenguaje— y los tests de pantalla tampoco, porque el mock devuelve el valor
 * que el propio autor inventó. Es el mismo defecto que H-2 y H-3 de la fase
 * con otra cara: **el contrato se escribe dos veces y nadie cruza las dos
 * copias**.
 *
 * Qué mide: para cada `export type X = "a" | "b"` de `src/api/*.ts`, si el
 * backend publica un `XLiteral = Literal["a", "b"]`, los dos conjuntos tienen
 * que ser iguales. Los tipos sin contraparte de mismo nombre no se miran — no
 * se inventa una correspondencia por parecido, que sería peor que no medir.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const API_DIR = join(__dirname, "..", "api")
const SCHEMAS_GLOB = join(__dirname, "..", "..", "..", "backend", "app")

function unionesDelCliente(): Map<string, { valores: Set<string>; archivo: string }> {
  const out = new Map<string, { valores: Set<string>; archivo: string }>()
  for (const archivo of readdirSync(API_DIR).filter((f) => f.endsWith(".ts"))) {
    const fuente = readFileSync(join(API_DIR, archivo), "utf8")
    const re = /export type ([A-Za-z0-9_]+)\s*=\s*((?:"[^"]*"\s*\|\s*)+"[^"]*")/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fuente)) !== null) {
      const valores = new Set([...m[2]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!))
      out.set(m[1]!, { valores, archivo })
    }
  }
  return out
}

function literalesDelServidor(): Map<string, { valores: Set<string>; archivo: string }> {
  const out = new Map<string, { valores: Set<string>; archivo: string }>()
  for (const dominio of readdirSync(SCHEMAS_GLOB, { withFileTypes: true })) {
    if (!dominio.isDirectory()) continue
    let fuente: string
    try {
      fuente = readFileSync(join(SCHEMAS_GLOB, dominio.name, "schemas.py"), "utf8")
    } catch {
      continue
    }
    const re = /([A-Za-z0-9_]+)\s*=\s*Literal\[([^\]]+)\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(fuente)) !== null) {
      const valores = new Set([...m[2]!.matchAll(/"([^"]*)"/g)].map((x) => x[1]!))
      if (valores.size > 0) out.set(m[1]!, { valores, archivo: `app/${dominio.name}/schemas.py` })
    }
  }
  return out
}

describe("los literales del cliente coinciden con los del servidor", () => {
  it("todo `export type X` con un `XLiteral` del backend publica exactamente los mismos valores", () => {
    const cliente = unionesDelCliente()
    const servidor = literalesDelServidor()

    const desacuerdos: string[] = []
    let cruzados = 0

    for (const [nombre, { valores, archivo }] of cliente) {
      const contraparte = servidor.get(`${nombre}Literal`)
      if (contraparte === undefined) continue
      cruzados += 1
      const soloCliente = [...valores].filter((v) => !contraparte.valores.has(v)).sort()
      const soloServidor = [...contraparte.valores].filter((v) => !valores.has(v)).sort()
      if (soloCliente.length > 0 || soloServidor.length > 0) {
        desacuerdos.push(
          `${nombre} (src/api/${archivo} vs ${contraparte.archivo}): ` +
            `el cliente inventa [${soloCliente.join(", ")}] · el servidor publica y el cliente ignora [${soloServidor.join(", ")}]`,
        )
      }
    }

    // Si el cruce deja de encontrar tipos, el invariante se volvió decorativo
    // (alguien renombró la convención `X`/`XLiteral`): eso también es un rojo.
    expect(cruzados, "el invariante dejó de cruzar tipos: revisá la convención de nombres").toBeGreaterThan(5)

    expect(
      desacuerdos,
      "hay tipos del cliente que no dicen lo mismo que el esquema del servidor. Un valor que el " +
        "servidor nunca manda deja muerta la rama de la pantalla que lo compara, y `tsc` no lo ve " +
        "porque los dos lados son literales válidos en su propio lenguaje.\n  - " +
        desacuerdos.join("\n  - "),
    ).toEqual([])
  })
})
