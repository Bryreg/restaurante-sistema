import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

const SRC = path.resolve(__dirname, "..")
const BACKEND = path.resolve(SRC, "../../backend")

/**
 * **Nómina y reparto de propinas** — auditor de la fase 3 (T6), tema: D-3,
 * las tablas de recargos con vigencia, y la línea del CST art. 149.
 *
 * Tres reglas que no se negocian:
 *
 * 1. **El reparto es una PROPUESTA que alguien confirma** (D-3). El «calcular»
 *    y el «confirmar» son dos llamadas distintas, y el «confirmar» es el que
 *    YA EXISTÍA desde 1b-2 (`POST /admin/tips/payouts`). Una pantalla que
 *    confirma sola convierte la propuesta en una transferencia automática, que
 *    es exactamente lo que D-3 prohíbe.
 * 2. **El contrato de API se cumple en las dos direcciones.** Una pantalla que
 *    llama a la ruta correcta con los parámetros equivocados es una pantalla
 *    rota: el servidor responde `422` y el dueño ve «no se pudo calcular» para
 *    siempre. Este archivo **lee la firma real del endpoint** y la compara con
 *    lo que el cliente manda — no repite ninguna lista a mano.
 * 3. **El sistema nunca calcula una deuda del empleado** (SPEC-NEGOCIO §3.2 y
 *    §11.16; CST art. 149). Ni en el backend ni en la pantalla, ni siquiera
 *    opcional, ni siquiera en cero.
 *
 * Rojo **por ausencia** = todavía no construido (lo dice el mensaje). Rojo
 * **por defecto** = construido y el número (o la llamada) miente.
 */

function archivosDe(dir: string, filtro: RegExp, acc: string[] = []): string[] {
  let entradas: string[]
  try {
    entradas = readdirSync(dir)
  } catch {
    return acc
  }
  for (const nombre of entradas) {
    const p = path.join(dir, nombre)
    if (statSync(p).isDirectory()) archivosDe(p, filtro, acc)
    else if (filtro.test(nombre)) acc.push(p)
  }
  return acc
}

function leer(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8")
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Lectura de la firma REAL de un endpoint de FastAPI.
// ---------------------------------------------------------------------------

interface EndpointBackend {
  metodo: string
  ruta: string
  requeridos: string[]
}

/** No son parámetros de query: son inyecciones del framework. */
const INYECCIONES = /Depends\(|:\s*(Actor|Session|Request)\b/

/**
 * Parámetros de query REQUERIDOS de cada endpoint de un router.
 *
 * "Requerido" = sin valor por defecto, o con `Query(...)` (Ellipsis). Los
 * parámetros de path se excluyen porque ya viajan en la URL.
 */
function endpointsDe(rutaRouter: string): EndpointBackend[] {
  const texto = leer(rutaRouter)
  if (texto === null) return []
  const out: EndpointBackend[] = []
  const decorador = /@router\.(get|post|patch|put|delete)\(\s*"([^"]+)"[\s\S]*?\ndef\s+\w+\(([\s\S]*?)\n\)\s*->/g
  for (const m of texto.matchAll(decorador)) {
    const metodo = m[1].toUpperCase()
    const ruta = m[2]
    const enPath = new Set([...ruta.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]))
    const requeridos: string[] = []
    for (const linea of m[3].split("\n")) {
      const cruda = linea.trim().replace(/,$/, "")
      if (cruda === "" || cruda.startsWith("#")) continue
      if (INYECCIONES.test(cruda)) continue
      const nombre = /^([A-Za-z_]\w*)\s*:/.exec(cruda)?.[1]
      if (!nombre || enPath.has(nombre)) continue
      const alias = /alias\s*=\s*"([^"]+)"/.exec(cruda)?.[1]
      const visible = alias ?? nombre
      const sinDefault = !cruda.includes("=")
      const queryEllipsis = /Query\(\s*\.\.\./.test(cruda)
      // Un cuerpo Pydantic (`payload: XIn`) no es query; se reconoce porque
      // su anotación es una clase `...In` sin `Query(`.
      const esCuerpo = /:\s*\w+In\b/.test(cruda) && !cruda.includes("Query(")
      if (esCuerpo) continue
      if (sinDefault || queryEllipsis) requeridos.push(visible)
    }
    out.push({ metodo, ruta, requeridos })
  }
  return out
}

/** Lo que un cliente `src/api/*.ts` manda en la query de cada ruta. */
function consumoDe(rutaCliente: string): Map<string, Set<string>> {
  const texto = leer(rutaCliente)
  const out = new Map<string, Set<string>>()
  if (texto === null) return out
  const llamada = /api<[^>]*>\(\s*(["`])([^"`]+)\1\s*,?\s*(\{[\s\S]{0,400}?\n?\s*\}\s*)?\)/g
  for (const m of texto.matchAll(llamada)) {
    const ruta = m[2].replace(/\$\{[^}]*\}/g, "{}")
    const opciones = m[3] ?? ""
    const metodo = /method:\s*"([A-Z]+)"/.exec(opciones)?.[1] ?? "GET"
    const bloque = /query:\s*\{([^}]*)\}/.exec(opciones)?.[1] ?? ""
    const claves = new Set(
      [...bloque.matchAll(/([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]),
    )
    out.set(`${metodo} ${ruta}`, claves)
  }
  return out
}

const DOMINIOS = [
  { dominio: "payroll", dueno: "T3 backend-nomina-propinas" },
  { dominio: "analytics", dueno: "T4 backend-analitica" },
  { dominio: "banking", dueno: "T1 backend-banco" },
  { dominio: "expenses", dueno: "T2 backend-obligaciones" },
] as const

describe("una pantalla que llama a la ruta correcta con los parámetros equivocados está rota", () => {
  for (const { dominio, dueno } of DOMINIOS) {
    it(`${dominio}: el cliente manda todos los parámetros que el endpoint exige`, () => {
      const endpoints = endpointsDe(path.join(BACKEND, "app", dominio, "router.py"))
      const consumo = consumoDe(path.join(SRC, "api", `${dominio}.ts`))

      expect(
        endpoints.length,
        `AUSENCIA (no defecto): \`app/${dominio}/router.py\` todavía no publica endpoints (${dueno})`,
      ).toBeGreaterThan(0)
      expect(
        consumo.size,
        `AUSENCIA (no defecto): \`src/api/${dominio}.ts\` todavía no llama a ninguna ruta (T5)`,
      ).toBeGreaterThan(0)

      const rotas: string[] = []
      for (const ep of endpoints) {
        const clave = `${ep.metodo} ${ep.ruta.replace(/\{[^}]*\}/g, "{}")}`
        const enviados = consumo.get(clave)
        if (enviados === undefined) continue // la pantalla no usa esta ruta: no es un defecto
        const faltantes = ep.requeridos.filter((p) => !enviados.has(p))
        if (faltantes.length > 0) {
          rotas.push(
            `${clave} — el servidor exige [${ep.requeridos.join(", ")}] y el cliente manda ` +
              `[${[...enviados].join(", ")}]; faltan: ${faltantes.join(", ")}`,
          )
        }
      }

      expect(
        rotas,
        `estas llamadas van a responder 422 SIEMPRE: la pantalla existe, la ruta existe, y no se ` +
          `pueden hablar. Son DOS hallazgos con dueños distintos según de qué lado esté el error — ` +
          `si el contrato de §2 fija los parámetros, el que se apartó es ${dueno}; si la pantalla ` +
          `inventó los suyos, es T5 frontend-fase3:\n` + rotas.join("\n"),
      ).toEqual([])
    })
  }
})

describe("D-3: la propuesta se calcula, el reparto se confirma aparte", () => {
  it("la pantalla de propinas llama a la propuesta y al «confirmar» que ya existía", () => {
    const cliente = leer(path.join(SRC, "api/payroll.ts"))
    if (cliente === null) {
      expect.fail("AUSENCIA (no defecto): `src/api/payroll.ts` todavía no existe (T5)")
      return
    }
    expect(
      /["`]\/admin\/tips\/distribution\/proposal["`]/.test(cliente),
      "la pantalla no consume `GET /admin/tips/distribution/proposal`, que es la ruta que el contrato " +
        "de §2 fija para la propuesta (dueño T5)",
    ).toBe(true)
    expect(
      /["`]\/admin\/tips\/payouts["`]/.test(cliente),
      "el «confirmar» de D-3 es `POST /admin/tips/payouts`, publicado desde 1b-2 " +
        "(`app/shifts/tips.py::register_tip_payout`). Si la pantalla no lo llama, o el reparto no se " +
        "puede confirmar, o alguien escribió una segunda puerta de escritura (dueño T5)",
    ).toBe(true)
  })

  it("el «confirmar» exige un acto explícito de la persona, no se dispara solo", () => {
    const tab = leer(path.join(SRC, "features/payroll/TipsTab.tsx"))
    if (tab === null) {
      expect.fail("AUSENCIA (no defecto): `features/payroll/TipsTab.tsx` todavía no existe (T5)")
      return
    }
    // Un `useEffect` que dispara el payout convertiría la propuesta en una
    // transferencia automática: exactamente lo que D-3 prohíbe.
    const sospechoso = /useEffect\([\s\S]{0,400}?(registerTipPayout|createTipPayout|payout)/.test(tab)
    expect(
      sospechoso,
      "la pantalla dispara el reparto desde un `useEffect`: D-3 dice que el sistema PROPONE y " +
        "REGISTRA, pero no mueve plata solo. El «confirmar» tiene que ser un acto de una persona " +
        "(dueño T5 frontend-fase3)",
    ).toBe(false)
    expect(
      /propuesta/i.test(tab),
      "la pantalla no le dice al usuario que lo que está viendo es una PROPUESTA que todavía no movió " +
        "plata: sin esa frase, una tabla con montos por persona se lee como un pago ya hecho (dueño T5)",
    ).toBe(true)
  })

  it("el default `by_hours` de D-3 no se decide en el cliente", () => {
    const cliente = leer(path.join(SRC, "api/payroll.ts"))
    const tab = leer(path.join(SRC, "features/payroll/TipsTab.tsx"))
    if (cliente === null || tab === null) {
      expect.fail("AUSENCIA (no defecto): falta el territorio de propinas del frontend (T5)")
      return
    }
    const malos: string[] = []
    for (const [nombre, texto] of [["api/payroll.ts", cliente], ["features/payroll/TipsTab.tsx", tab]] as const) {
      texto.split("\n").forEach((linea, i) => {
        if (/(\?\?|\|\|)\s*"by_hours"/.test(linea)) malos.push(`${nombre}:${i + 1}  ${linea.trim()}`)
      })
    }
    expect(
      malos,
      "el cliente pone el default `by_hours` por su cuenta. D-3 dice que el método es configuración " +
        "DE SEDE y que el backend lo resuelve: un default del cliente y un default del servidor que se " +
        "separen reparten plata de dos formas distintas (dueño T5):\n" + malos.join("\n"),
    ).toEqual([])
  })

  it("los tres métodos de D-3 están en el tipo del cliente", () => {
    const cliente = leer(path.join(SRC, "api/payroll.ts"))
    if (cliente === null) {
      expect.fail("AUSENCIA (no defecto): `src/api/payroll.ts` todavía no existe (T5)")
      return
    }
    for (const metodo of ["equal_shares", "by_hours", "by_area"]) {
      expect(
        cliente.includes(metodo),
        `D-3 construye los TRES métodos y el cliente no conoce \`${metodo}\`: una sede configurada ` +
          "así va a ver un código crudo en pantalla (dueño T5)",
      ).toBe(true)
    }
  })
})

describe("la nómina se liquida con la tabla de su época y lo dice en pantalla", () => {
  it("la pantalla de liquidación muestra qué tabla vigente usó", () => {
    const tab = leer(path.join(SRC, "features/payroll/RunsTab.tsx"))
    if (tab === null) {
      expect.fail("AUSENCIA (no defecto): `features/payroll/RunsTab.tsx` todavía no existe (T5)")
      return
    }
    expect(
      /tables_used|valid_from/.test(tab),
      "§2 fija que «la respuesta nombra qué tabla vigente usó» — y una liquidación que no dice con qué " +
        "tabla se calculó no se puede auditar contra la ley del mes. La pantalla tiene que mostrarlo " +
        "(dueño T5; si el backend no lo manda, dueño T3)",
    ).toBe(true)
  })

  it("el backend publica la tabla usada, que es la mitad de ida de lo anterior", () => {
    const esquemas = leer(path.join(BACKEND, "app/payroll/schemas.py"))
    if (esquemas === null) {
      expect.fail("AUSENCIA (no defecto): `app/payroll/schemas.py` todavía no existe (T3)")
      return
    }
    expect(
      /tables_used|surcharge_table/.test(esquemas),
      "la liquidación no publica la tabla de recargos que usó: sin eso, recalcular un período viejo " +
        "«con las tablas de su época» no se puede verificar desde afuera (dueño T3)",
    ).toBe(true)
    expect(
      /valid_from/.test(esquemas),
      "las tablas de recargos van parametrizadas CON VIGENCIA (§7, y el mismo patrón que " +
        "`StoreFiscalConfig`): sin `valid_from` publicado, la tabla está quemada o es irrastreable " +
        "(dueño T3)",
    ).toBe(true)
  })
})

describe("la línea del CST art. 149 no se cruza tampoco en la pantalla", () => {
  it("ninguna pantalla de nómina nombra una deuda del empleado ni un descuento por faltante", () => {
    const PROHIBIDAS = [/\bdeuda\b/i, /\bdebt\b/i, /\bowes\b/i, /payroll_deduction/i, /descuento por faltante/i]
    const malos: string[] = []
    for (const archivo of archivosDe(path.join(SRC, "features/payroll"), /\.tsx?$/)) {
      if (/__tests__/.test(archivo)) continue
      const texto = readFileSync(archivo, "utf8")
      texto.split("\n").forEach((linea, i) => {
        // El comentario que EXPLICA la prohibición no es una infracción.
        if (/CST|149|prohib|nunca/i.test(linea)) return
        if (PROHIBIDAS.some((p) => p.test(linea))) {
          malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
        }
      })
    }
    expect(
      malos,
      "una pantalla de nómina nombra una deuda del empleado o un descuento por faltante de caja. " +
        "CST art. 149 prohíbe deducir del salario sin orden escrita para cada caso, y §11.16 lo declara " +
        "no negociable: un faltante se resuelve con la causa tipada y la conversación que corresponda " +
        "(dueño T5, y T3 si el campo viene del servidor):\n" + malos.join("\n"),
    ).toEqual([])
  })

  it("ninguna pantalla de nómina convierte minutos en horas por su cuenta", () => {
    // Las horas tienen escala entera declarada (`app/core/hours.py`,
    // `HOURS_SCALE = 60`) y el backend publica el texto ya formateado. Un
    // `/ 60` en el cliente es un `float` (CRUCE 4) y una segunda matemática.
    const malos: string[] = []
    for (const archivo of archivosDe(path.join(SRC, "features/payroll"), /\.tsx?$/)) {
      if (/__tests__/.test(archivo)) continue
      readFileSync(archivo, "utf8")
        .split("\n")
        .forEach((linea, i) => {
          const sinComentario = linea.replace(/\/\/.*$/, "")
          if (/_minutes[^\n]*\/\s*60|\/\s*60\b/.test(sinComentario)) {
            malos.push(`${path.relative(SRC, archivo)}:${i + 1}  ${linea.trim()}`)
          }
        })
    }
    expect(
      malos,
      "estas líneas dividen minutos por 60 en el cliente: en TypeScript eso es un `float` (CRUCE 4) y " +
        "además es la segunda matemática de la jornada. El backend ya publica las horas formateadas " +
        "(`app/core/hours.py::format_hours`) (dueño T5):\n" + malos.join("\n"),
    ).toEqual([])
  })
})
