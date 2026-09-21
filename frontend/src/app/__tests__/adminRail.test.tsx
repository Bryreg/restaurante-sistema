/**
 * **El rail no puede perder una entrada, ni inventarse un nombre.**
 *
 * `AdminLayout.test.tsx` mockea `@/features/shifts` y `@/features/catalog`
 * para probar el filtrado por flags, y con esos mocks puestos el rail ve
 * rutas que no existen. Acá no hay ningún mock: se arma la navegación real,
 * con las veinticinco entradas encendidas, y se la compara contra la tabla
 * del armazón.
 *
 * Las cuatro afirmaciones salen de cómo puede romperse la cosa:
 *
 * - una entrada nueva de un dominio que nadie archiva en un grupo cae al
 *   fondo de Sistema con el ícono genérico, que es justo el defecto que el
 *   rediseño vino a arreglar;
 * - el nombre largo está escrito dos veces —en el dominio y en el rail— para
 *   que el censo de controles lo vea, y dos copias derivan;
 * - el nombre corto es lo que se ve y el largo es el nombre accesible: si el
 *   corto deja de abrir al largo, quien dicta por voz nombra algo que el
 *   navegador no reconoce (WCAG 2.5.3, «Label in Name»);
 * - dos entradas con el mismo ícono son dos entradas que se ven iguales.
 */
import { describe, expect, it } from "vitest"

import { GRUPOS, RAIL, buildNav } from "../AdminLayout"

/** Las veinticinco: toda función encendida, que es el peor caso del rail. */
const TODAS = buildNav(() => true)

describe("el rail del admin: la tabla de grupos", () => {
  it("hay entradas suficientes como para que este test proteja algo", () => {
    expect(TODAS.length).toBeGreaterThanOrEqual(25)
  })

  it("toda entrada de navegación está archivada en un grupo", () => {
    const huerfanas = TODAS.filter((item) => !RAIL[item.to]).map(
      (item) => `«${item.label}» (${item.to}) no está en RAIL: caería al fondo de Sistema`,
    )
    expect(huerfanas).toEqual([])
  })

  it("no sobra ninguna fila: toda clave de RAIL es una ruta que la navegación produce", () => {
    const rutas = new Set(TODAS.map((item) => item.to))
    expect(Object.keys(RAIL).filter((to) => !rutas.has(to))).toEqual([])
  })

  it("el nombre completo del rail es el `label` del dominio, sin deriva", () => {
    const deriva = TODAS.filter((item) => RAIL[item.to] && RAIL[item.to].title !== item.label).map(
      (item) => `${item.to}: el rail dice «${RAIL[item.to].title}» y el dominio «${item.label}»`,
    )
    expect(deriva).toEqual([])
  })

  it("el nombre corto abre al largo, para que el nombre accesible contenga lo que se ve", () => {
    const malos = Object.entries(RAIL)
      .filter(([, fila]) => !fila.title.startsWith(fila.label))
      .map(([to, fila]) => `${to}: «${fila.label}» no es el principio de «${fila.title}»`)
    expect(malos).toEqual([])
  })

  it("los cuatro nombres que el patrón 1 acorta están acortados, y ningún otro", () => {
    const acortados = Object.entries(RAIL)
      .filter(([, fila]) => fila.label !== fila.title)
      .map(([, fila]) => fila.label)
      .sort()
    expect(acortados).toEqual(["Devoluciones", "Documentos", "Rangos", "Turnos"])
  })

  it("ninguna entrada repite el ícono de otra", () => {
    const porIcono = new Map<unknown, string[]>()
    for (const [to, fila] of Object.entries(RAIL)) {
      porIcono.set(fila.icon, [...(porIcono.get(fila.icon) ?? []), to])
    }
    const repetidos = [...porIcono.values()].filter((rutas) => rutas.length > 1)
    expect(repetidos).toEqual([])
  })

  it("los seis grupos existen y ninguno queda vacío", () => {
    expect(GRUPOS).toEqual(["Operación", "Costos", "Plata", "Ley", "Gente", "Sistema"])
    const vacios = GRUPOS.filter(
      (grupo) => !TODAS.some((item) => RAIL[item.to]?.grupo === grupo),
    )
    expect(vacios).toEqual([])
  })

  it("las cuatro entradas con recuento son las cuatro que el pedido nombra", () => {
    const conCuenta = Object.values(RAIL)
      .filter((fila) => fila.cuenta)
      .map((fila) => fila.title)
      .sort()
    expect(conCuenta).toEqual(["Compras", "Devoluciones pendientes", "Inventario", "Pedidos"])
  })
})

describe("el rail del admin: el orden dentro del grupo", () => {
  /**
   * `buildNav` concatena los dominios por fase, así que «Dinero»
   * (`shiftsFeature`, fase 3) caía después de Banco, Nómina y Propinas: la
   * pantalla principal de plata, última de su propio grupo. El orden de
   * lectura lo manda `RAIL`.
   */
  it("Plata abre con Dinero, no lo deja al final", () => {
    const plata = Object.entries(RAIL)
      .filter(([, fila]) => fila.grupo === "Plata")
      .map(([, fila]) => fila.label)
    expect(plata[0]).toBe("Dinero")
  })

  it("cada grupo se lee en el orden en que está escrito en RAIL", () => {
    const rutas = Object.keys(RAIL)
    for (const grupo of GRUPOS) {
      const indices = rutas
        .map((to, i) => ({ to, i }))
        .filter(({ to }) => RAIL[to].grupo === grupo)
        .map(({ i }) => i)
      // Las filas de un grupo van juntas y seguidas: si se intercalaran, el
      // orden escrito dejaría de ser el orden que se ve.
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
      expect(indices[indices.length - 1] - indices[0]).toBe(indices.length - 1)
    }
  })
})
