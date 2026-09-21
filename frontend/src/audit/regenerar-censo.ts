/**
 * Regenera `censo-controles.json` desde el código de hoy.
 *
 * Se corre a propósito, nunca en CI: la gracia de la base es que quede fija
 * mientras el rediseño avanza. Si un rótulo cambió por una decisión, se
 * regenera y el diff muestra qué se movió.
 *
 *     npx tsx src/audit/regenerar-censo.ts
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"

import { censarArchivo, type Censo } from "./censo"

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..")

function tsxDe(dir: string): string[] {
  const salida: string[] = []
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada)
    if (statSync(ruta).isDirectory()) {
      if (entrada === "__tests__") continue
      salida.push(...tsxDe(ruta))
    } else if (entrada.endsWith(".tsx") && !entrada.endsWith(".test.tsx")) {
      salida.push(ruta)
    }
  }
  return salida
}

const censo: Censo = {}
for (const ruta of [...tsxDe(join(SRC, "features")), ...tsxDe(join(SRC, "app"))].sort()) {
  const rotulos = censarArchivo(readFileSync(ruta, "utf8"))
  if (rotulos.length > 0) censo[relative(SRC, ruta)] = rotulos
}

writeFileSync(join(SRC, "audit", "censo-controles.json"), JSON.stringify(censo, null, 1) + "\n")
console.log(
  `archivos: ${Object.keys(censo).length} · rótulos: ${Object.values(censo).reduce((n, r) => n + r.length, 0)}`,
)
