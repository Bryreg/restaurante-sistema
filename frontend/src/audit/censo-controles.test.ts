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
 *
 * ---
 *
 * **Bajas declaradas · «Hoy» tal cual la maqueta `a2`.** Tres rótulos de
 * `features/reports/TodayPage.tsx` se sacaron a mano de la base, uno por uno
 * y no regenerándola entera: la base es lo que había **antes** del rediseño,
 * y volver a tomarla hoy la re-ancla en 128 archivos de una sola vez y tapa
 * lo que todavía protege. Los tres, con su motivo:
 *
 * - «Del día» y «Ahora mismo» — eran los dos rótulos de grupo que partían
 *   los indicadores en 4 + 3. `a2` dibuja **una sola grilla de ocho**
 *   (`.kpis`; su catálogo de patrones lo dice literal: «En Hoy, ocho»), y con
 *   el rótulo de grupo la segunda fila quedaba coja. Lo que decían —qué ya
 *   está cerrado y qué sigue vivo— lo sigue diciendo el pie de cada tarjeta.
 *   Ninguno era un control: eran encabezados.
 * - «Propinas de hoy — no son venta» — era el renglón de abajo de la raya de
 *   la banda de cifra. La propina pasó a ser la **octava tarjeta**, que es
 *   donde `a2` la pone, y sigue rotulada como que no es venta del
 *   restaurante (Ley 1935 de 2018): la cifra rectora sigue sin incluirla.
 *
 * «Día operativo» **no** se dio de baja aunque salió de la franja de
 * contexto: viaja como `title` de la pastilla de fecha de la cabecera, que
 * es el control que lo reemplazó.
 *
 * **Bajas declaradas · «Orden y aire».** El dueño comparó el admin con el de
 * café-sistema y lo encontró agobiante; el mapa de pantallas que aprobó pide
 * sacar de la vista el texto que explica en vez de dar un dato. Salen de la
 * base, a mano y una por una, sólo frases que el censo levantaba porque
 * viajaban en un `label:`/`title=` pero que **no eran controles**:
 *
 * - «Seis pestañas: dos de consignaciones y cuatro del libro del banco.»
 *   (`features/banking/BankingAdminPage.tsx`) — describía la fila de
 *   pestañas, que ahora son tres y «Más».
 * - «Sólo lectura: acá no se cambia nada, se mira.», «Sobre el costo
 *   congelado en la venta» y su `title` «El costo viaja congelado en el ítem
 *   vendido…» (`features/analytics/AnalyticsAdminPage.tsx`) — franja de
 *   contexto que explicaba; lo que decía pasó a la pregunta plegada.
 * - «La liquidación es para control interno, no es la liquidación legal» y
 *   «La fórmula del Código Sustantivo del Trabajo combina los recargos…»
 *   (`features/payroll/PayrollAdminPage.tsx`) — repetían el aviso que sigue
 *   arriba de Liquidaciones en `RunsTab.tsx`. «Nómina y propinas están las
 *   dos encendidas.» no era un dato.
 * - «Propinas» (la `TabsTrigger` de `PayrollAdminPage.tsx`) — **éste sí era
 *   un control, y no se perdió: se movió.** Con el admin en ocho secciones,
 *   Propinas es pestaña de la sección Equipo (`app/AdminLayout.tsx`, `RAIL`,
 *   que el censo sí ve) y la página no la repite en su propia fila.
 * - «Diez secciones, agrupadas en el índice.» y «Marcadas con un punto ámbar
 *   en el índice.» (`features/settings/SettingsPage.tsx`) — describían un
 *   índice de diez pestañas que ahora son tres y «Más».
 * - «Operacional muestra los turnos de hoy; Historial, cualquier rango.»,
 *   «Los rescates de administrador viven en el detalle de cada turno» y
 *   «Cierre administrativo, Reabrir, Cancelar y Ajustar apertura se abren
 *   desde «Ver detalle» de una fila.» (`features/shifts/admin/MoneyAdminPage.tsx`)
 *   — explicaban dónde están los controles; los controles siguen donde
 *   estaban y la explicación pasó a la pregunta plegada.
 *
 * **Bajas declaradas · merma en la tablet.** Dos rótulos de
 * `features/inventory/WastePage.tsx` salen de la base, a mano. Ninguno era
 * un control: eran los `placeholder` de dos listas desplegables que se
 * reemplazaron por controles más grandes para el dedo, y los controles
 * siguen ahí.
 *
 * - «Elegí una opción» — la lista de 58 insumos pasó a ser un buscador
 *   («Buscar insumo» / «Buscar preparación») con recientes y botones.
 * - «Elegí un tipo» — el tipo de merma pasó a ser una fila de botones de
 *   ≥ 56 px bajo el rótulo «Tipo»; cada tipo sigue siendo tocable.
 *
 * **Bajas declaradas · la comanda en la tablet.** Un rótulo de
 * `features/orders/ItemDialog.tsx` sale de la base, a mano. No era un
 * control: era el `placeholder` de la lista desplegable de curso (~34 px),
 * que pasó a ser una fila de botones de 56 px bajo el rótulo «Curso», uno
 * por curso, arrancando ya en el curso por defecto del plato.
 *
 * - «Por defecto del producto» — con el curso del plato preelegido no hay
 *   estado «sin elegir» que nombrar; cada curso sigue siendo tocable.
 *
 * («Elegí un motivo» de `VoidDialog.tsx` **no** se dio de baja: la lista de
 * motivos pasó a ser una grilla de botones de 56 px, y el rótulo viaja como
 * `aria-label` del grupo que los reúne.)
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
