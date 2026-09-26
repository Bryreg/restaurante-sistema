/**
 * Toda pantalla recibe una densidad.
 *
 * Nace de un defecto que apareció al mirar la app en un navegador, no en un
 * test: al llevar el sistema de `m2b` a la capa de tokens, la densidad se
 * puso en `PosLayout` y en `AdminLayout`, que es donde vive el 92 % de las
 * pantallas. Pero **tres rutas cuelgan fuera de los dos layouts** —
 * `/pos/activate`, `/pos/identify` y `/login`— y quedaron con la escala por
 * defecto del navegador, 16 px, sin `--control-min-h`.
 *
 * Las dos primeras son teclados de PIN en una tablet compartida: son
 * literalmente donde el dedo toca el producto por primera vez, y son las que
 * más necesitan el objetivo táctil de 52 px. Nada falló: ni `tsc`, ni los
 * tests, ni el build. La pantalla simplemente se dibujaba chica.
 *
 * Qué mide: que toda ruta declarada en `app/router.tsx` termine bajo una
 * densidad — o porque su elemento es un layout que llama a `useDensity`, o
 * porque el componente de la pantalla la llama él mismo. No mide que la
 * densidad elegida sea la correcta (eso es criterio, no invariante); mide lo
 * único que falló acá, que es que no hubiera ninguna.
 *
 * Si mañana se agrega una ruta fuera de los layouts, este test la encuentra
 * antes que un ojo humano.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

const SRC = join(__dirname, "..")

const leer = (ruta: string): string => readFileSync(join(SRC, ruta), "utf8")

/**
 * Los elementos que el router monta en el nivel superior, con el archivo que
 * los define. Los hijos de `/admin` y `/pos` no entran: heredan la densidad
 * de su layout, que es justamente el mecanismo que funciona.
 */
const RAIZ = [
  { ruta: "/login", archivo: "features/auth/LoginPage.tsx", superficie: "escritorio" },
  { ruta: "/pos/activate", archivo: "features/auth/DeviceActivatePage.tsx", superficie: "tablet" },
  { ruta: "/pos/identify", archivo: "features/auth/DeviceIdentifyPage.tsx", superficie: "tablet" },
  { ruta: "/admin", archivo: "app/AdminLayout.tsx", superficie: "escritorio" },
  { ruta: "/pos", archivo: "app/PosLayout.tsx", superficie: "tablet" },
  // La puerta (`HomePage`, «Operar (POS)» o «Administrar»): antes `/` sólo
  // redirigía a `/login` y no dibujaba nada; ahora es una pantalla fuera de
  // los layouts, así que entra a la tabla como las demás.
  { ruta: "/", archivo: "app/HomePage.tsx", superficie: "escritorio" },
] as const

describe("densidad", () => {
  it.each(RAIZ)(
    "$ruta ($superficie) declara una densidad",
    ({ ruta, archivo, superficie }) => {
      const fuente = leer(archivo)
      expect(
        /useDensity\(\s*"(salon|oficina)"\s*\)/.test(fuente),
        `${ruta} se monta fuera de todo layout y ${archivo} no llama a useDensity(): ` +
          `se va a dibujar con la escala por defecto del navegador (16 px, sin ` +
          `--control-min-h) en vez de la de ${superficie}. No rompe nada — sólo ` +
          `se ve chica, que es peor porque nadie se entera.`,
      ).toBe(true)
    },
  )

  it("el router no monta ninguna otra ruta de nivel superior sin densidad", () => {
    const router = leer("app/router.tsx")

    // `path: "..."` en el nivel superior del arreglo `routes`, con su elemento
    // en la misma entrada. Los hijos van dentro de `children:` y no se miran.
    const nivelSuperior = router.slice(
      router.indexOf("const routes: RouteObject[]"),
      router.indexOf("export const router"),
    )
    const conocidas = new Set<string>([
      ...RAIZ.map((r) => r.ruta),
      "*", // sólo redirige a la puerta (`/`)
    ])

    const declaradas = [...nivelSuperior.matchAll(/^ {2}\{ ?path: "([^"]+)"/gm)].map((m) => m[1])
    const sinRevisar = declaradas.filter((p) => !conocidas.has(p))

    expect(
      sinRevisar,
      `hay rutas de nivel superior que esta tabla no conoce: ${sinRevisar.join(", ")}. ` +
        `Si cuelgan fuera de un layout necesitan su propio useDensity(); agregalas a RAIZ.`,
    ).toEqual([])
  })
})
