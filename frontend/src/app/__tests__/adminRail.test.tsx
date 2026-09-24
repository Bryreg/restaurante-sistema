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

import { RAIL, SECCIONES, buildNav, pantallaActiva } from "../AdminLayout"

/** Todas: toda función encendida, que es el peor caso del rail. */
const TODAS = buildNav(() => true)

describe("el rail del admin: la tabla de secciones", () => {
  it("hay pantallas suficientes como para que este test proteja algo", () => {
    expect(TODAS.length).toBeGreaterThanOrEqual(25)
  })

  it("toda pantalla está archivada en una sección", () => {
    const huerfanas = TODAS.filter((item) => !RAIL[item.to]).map(
      (item) => `«${item.label}» (${item.to}) no está en RAIL: caería como pestaña suelta de Ajustes`,
    )
    expect(huerfanas).toEqual([])
  })

  it("no sobra ninguna fila: toda clave de RAIL es una ruta que la navegación produce", () => {
    const rutas = new Set(TODAS.map((item) => item.to))
    expect(Object.keys(RAIL).filter((to) => !rutas.has(to))).toEqual([])
  })

  it("el nombre completo es el `label` del dominio, sin deriva", () => {
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

  it("los cuatro nombres acortados están acortados, y ningún otro", () => {
    const acortados = Object.entries(RAIL)
      .filter(([, fila]) => fila.label !== fila.title)
      .map(([, fila]) => fila.label)
      .sort()
    expect(acortados).toEqual(["Devoluciones", "Documentos", "Rangos", "Turnos"])
  })

  /**
   * Son las ocho del mapa de pantallas que el dueño aprobó («De 25 entradas a
   * 8»); este `toEqual` es el que hace que agregar una novena sea una decisión
   * y no un descuido.
   */
  it("las ocho secciones existen, en el orden del mapa, y ninguna queda vacía", () => {
    expect(SECCIONES).toEqual(["Hoy", "Informes", "Caja", "Inventario", "Carta", "Plata", "Equipo", "Ajustes"])
    const vacias = SECCIONES.filter((seccion) => !TODAS.some((item) => RAIL[item.to]?.seccion === seccion))
    expect(vacias).toEqual([])
  })

  it("las cuatro pantallas con recuento son las cuatro que el pedido nombra", () => {
    const conCuenta = Object.values(RAIL)
      .filter((fila) => fila.cuenta)
      .map((fila) => fila.title)
      .sort()
    expect(conCuenta).toEqual(["Compras", "Devoluciones pendientes", "Inventario", "Pedidos"])
  })

  it("las filas de una sección van juntas y seguidas: el orden escrito es el orden de las pestañas", () => {
    const rutas = Object.keys(RAIL)
    for (const seccion of SECCIONES) {
      const indices = rutas
        .map((to, i) => ({ to, i }))
        .filter(({ to }) => RAIL[to].seccion === seccion)
        .map(({ i }) => i)
      expect(indices).toEqual([...indices].sort((a, b) => a - b))
      expect(indices[indices.length - 1] - indices[0]).toBe(indices.length - 1)
    }
  })

  it("cada sección abre en su pantalla principal", () => {
    const primera = (seccion: string) => Object.entries(RAIL).find(([, fila]) => fila.seccion === seccion)?.[0]
    expect(primera("Caja")).toBe("/admin/dinero")
    expect(primera("Informes")).toBe("/admin/ventas")
    expect(primera("Ajustes")).toBe("/admin/settings")
  })
})

describe("el rail del admin: qué pantalla se está mirando", () => {
  it("una ruta hija cuenta como su pantalla (el detalle de un documento es Documentos)", () => {
    expect(pantallaActiva(TODAS, "/admin/fiscal/documentos/12", "")?.to).toBe("/admin/fiscal/documentos")
  })

  it("con `?tab=` manda la pestaña: Propinas y no Nómina", () => {
    expect(pantallaActiva(TODAS, "/admin/nomina", "?tab=propinas")?.to).toBe("/admin/nomina?tab=propinas")
    expect(pantallaActiva(TODAS, "/admin/nomina", "?tab=horas")?.to).toBe("/admin/nomina")
  })

  it("una ruta que no es de ninguna pantalla no enciende nada", () => {
    expect(pantallaActiva(TODAS, "/admin", "")).toBeUndefined()
  })
})
