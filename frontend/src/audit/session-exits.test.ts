/**
 * Toda entrada tiene una salida cableada a una pantalla.
 *
 * Nace de un defecto que encontró el dueño usando la app, no un test:
 * **no había botón para salir**. `logout()` estaba en `src/api/auth.ts`
 * desde la fase 1a y `deviceDeactivate()` desde 1b; las dos tipaban bien,
 * las dos apuntaban a un endpoint que existe y funciona, y **ninguna tenía
 * un solo llamador en toda la app**. Un envoltorio de API sin llamador no
 * rompe `tsc` ni ningún test de pantalla: simplemente la capacidad no
 * existe para quien usa el producto.
 *
 * Qué mide: por cada forma de *entrar* a una sesión, que la función que la
 * *cierra* se importe de `@/api/auth` y se llame desde un módulo de
 * pantalla —fuera de `src/api/` y fuera de los tests—. No mide que el botón
 * se vea ni que haga lo correcto: eso lo miden `AdminLayout.test.tsx` y
 * `PosLayout.test.tsx`. Mide lo único que falló acá, que es que nadie la
 * llamara.
 *
 * `authorize()` no está en la tabla a propósito: es una autorización de un
 * solo uso, no una sesión, y la app la manda inline como `authorizer_pin`
 * en cada escritura. No tiene de qué salir.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const SRC = join(__dirname, "..")

/** Entrada → salida. Las tres sesiones de SPEC-NEGOCIO §9.1. */
const SESIONES = [
  {
    sesion: "admin (correo y contraseña)",
    entra: "adminLogin",
    sale: "logout",
    consecuencia: "se entra al admin y no hay forma de salir salvo borrar la cookie a mano",
  },
  {
    sesion: "dispositivo (PIN de sede)",
    entra: "deviceActivate",
    sale: "deviceDeactivate",
    consecuencia:
      "la tablet queda atada a la sede que se activó: no se puede mover a otra ni corregir la equivocada",
  },
  {
    sesion: "persona (PIN de 4 dígitos)",
    entra: "deviceIdentify",
    sale: "deviceRelease",
    consecuencia: "la persona identificada no puede soltar el dispositivo para que atienda otra",
  },
] as const

/** Módulos de pantalla: todo `src/**\/*.ts(x)` que no sea cliente de API ni test. */
function modulosDePantalla(dir: string, out: string[] = []): string[] {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada)
    if (statSync(ruta).isDirectory()) {
      if (entrada === "api" && dir === SRC) continue
      modulosDePantalla(ruta, out)
      continue
    }
    if (!/\.tsx?$/.test(entrada)) continue
    if (/\.test\.tsx?$/.test(entrada)) continue
    out.push(ruta)
  }
  return out
}

describe("cada sesión que se puede abrir se puede cerrar desde una pantalla", () => {
  const modulos = modulosDePantalla(SRC).map((ruta) => ({
    ruta,
    fuente: readFileSync(ruta, "utf8"),
  }))

  it.each(SESIONES)(
    "la sesión de $sesion se abre con $entra y se cierra con $sale",
    ({ entra, sale, consecuencia }) => {
      const declarada = readFileSync(join(SRC, "api", "auth.ts"), "utf8")
      expect(declarada, `\`${entra}\` ya no existe en src/api/auth.ts`).toContain(
        `export function ${entra}(`,
      )
      expect(declarada, `\`${sale}\` ya no existe en src/api/auth.ts`).toContain(
        `export function ${sale}(`,
      )

      const llamadores = modulos
        .filter(({ fuente }) => {
          const importa = new RegExp(`import\\s*\\{[^}]*\\b${sale}\\b[^}]*\\}\\s*from\\s*"@/api/auth"`, "s")
          const llama = new RegExp(`\\b${sale}\\s*\\(`)
          return importa.test(fuente) && llama.test(fuente)
        })
        .map(({ ruta }) => ruta.slice(SRC.length + 1))

      expect(
        llamadores,
        `ninguna pantalla llama a \`${sale}()\`. Se puede abrir la sesión de ` +
          `${entra === "adminLogin" ? "admin" : entra === "deviceActivate" ? "dispositivo" : "persona"} ` +
          `y no cerrarla: ${consecuencia}. Un envoltorio de API sin llamador tipa bien y ` +
          `no lo ve ningún test de pantalla, pero la capacidad no existe para quien usa el producto.`,
      ).not.toEqual([])
    },
  )
})
