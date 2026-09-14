// @vitest-environment node
/**
 * Guardrail de todo el equipo (no sólo de este agente): nada de sesión vive
 * en `localStorage`/`sessionStorage` — sólo el tema claro/oscuro puede
 * (AGENTS.md § "Sesión en cookie httpOnly"; contrato interno § 5). Corre en
 * `environment: "node"` porque sólo lee archivos, no usa el DOM.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));

const FORBIDDEN_PATTERNS = [/localStorage\s*\.\s*setItem\s*\(/, /sessionStorage\s*\.\s*setItem\s*\(/];

function isSourceFile(name: string): boolean {
  return (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.endsWith(".d.ts");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (isSourceFile(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("nada de sesión en localStorage/sessionStorage fuera del tema", () => {
  it("no aparece localStorage.setItem ni sessionStorage.setItem salvo en el módulo de tema o en un test", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      const relativePath = relative(SRC_DIR, file).replace(/\\/g, "/");
      // El tema claro/oscuro es la única excepción declarada por AGENTS.md;
      // y un archivo de test puede mencionar las cadenas como texto (como
      // este mismo) sin que eso sea una llamada real fuera del tema.
      if (/(^|\/)theme\.tsx?$/i.test(relativePath)) continue;
      if (/__tests__\//.test(relativePath)) continue;

      const source = readFileSync(file, "utf-8");
      if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(source))) {
        offenders.push(relativePath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
