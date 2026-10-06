import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { formatPct } from "@/lib/format"
import { buildMe, renderWithProviders } from "@/test/utils"

/** `formatPct` escribe «12,3 %» con espacio fino; Testing Library compara el texto ya normalizado a espacios comunes. */
const pct = (bp: number): string => formatPct(bp).replace(/\s+/g, " ")

import { TodayPage } from "../TodayPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { getTodayMock } = vi.hoisted(() => ({ getTodayMock: vi.fn() }))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday: getTodayMock }
})

function baseToday(overrides: Partial<Awaited<ReturnType<typeof getTodayMock>>> = {}) {
  return {
    store_id: 1,
    business_date: "2026-09-15",
    sales_by_hour: [{ hour: 12, gross: 100000, net: 92593 }],
    gross: 100000,
    net: 92593,
    tax: 7407,
    tips_total: 9000,
    tips_by_method: [{ method: "cash", amount: 9000 }],
    orders: 5,
    covers: 12,
    avg_ticket: 18519,
    avg_per_cover: 7716,
    tables_occupied: 2,
    tables_total: 8,
    open_orders: [],
    unsent_count: 0,
    unpaid_count: 0,
    expected_cash: 250000,
    unavailable_products: [],
    pending_refunds_count: 0,
    unreviewed_closes_count: 0,
    alerts: [],
    ingredients_below_min: [],
    ingredients_negative: [],
    preps_without_production: [],
    products_discounting_nothing: [],
    ...overrides,
  }
}

/**
 * El enlace de un aviso del riel (`docs/PATRONES-ADMIN.md` § 6 y § 7).
 *
 * Antes de la ola 2 cada aviso era UNA tarjeta que era toda ella un enlace, y
 * por eso el nombre accesible del enlace era el título del aviso. El patrón 7
 * los separa a propósito: el título lleva la cifra adelante y la consecuencia
 * en el cuerpo, y **el enlace nombra el destino en palabras** («Inventario ›
 * Stock» + pastilla «negativos»), nunca la consulta cruda. Así que el enlace
 * se busca dentro del aviso, por su título — que es lo que estas pruebas
 * querían decir: *este* aviso lleva a *ese* lugar.
 */
function noticeLink(title: RegExp | string): HTMLElement {
  const item = screen.getByText(title).closest("li")
  expect(item).not.toBeNull()
  return within(item as HTMLElement).getByRole("link")
}

describe("TodayPage", () => {
  it("muestra el pulso del día: ventas netas grande y primero, con el resto como contexto", async () => {
    getTodayMock.mockResolvedValue(baseToday())

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Ventas netas de hoy")).toBeInTheDocument())
    expect(screen.getAllByText("$ 92.593").length).toBeGreaterThan(0)
    // Cambio intencional (decisión del dueño, 2026-09-29): Hoy lleva sólo
    // ticket promedio, número de tickets, efectivo y tarjeta debajo de la
    // venta. Las mesas ocupadas, las comandas abiertas, el efectivo esperado
    // y las propinas salieron de Hoy (siguen en Pedidos y Dinero).
    expect(screen.getByText("Ticket promedio")).toBeInTheDocument()
    expect(screen.getByText("Número de tickets")).toBeInTheDocument()
    expect(screen.getByText("Ventas en efectivo")).toBeInTheDocument()
    expect(screen.getByText("Ventas en tarjeta")).toBeInTheDocument()
    for (const fuera of ["Mesas ocupadas", "Comandas abiertas", "Efectivo esperado", "Propinas de hoy"]) {
      expect(screen.queryByText(fuera)).not.toBeInTheDocument()
    }
    // h1 (aprobado por el dueño): vuelven los comensales y el promedio por
    // comensal, con `null` dicho como «sin comensales registrados».
    expect(screen.getByText("Comensales")).toBeInTheDocument()
    expect(screen.getByText("Promedio por comensal")).toBeInTheDocument()
    expect(screen.getByText("Todo al día")).toBeInTheDocument()
  })

  it("«sin turno abierto» aparece cuando expected_cash es null, nunca como $0", async () => {
    getTodayMock.mockResolvedValue(baseToday({ expected_cash: null }))

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText("Sin turno abierto").length).toBeGreaterThan(0))
    // Cambio intencional (2026-09-29): la tarjeta «Efectivo esperado» salió
    // de Hoy; el aviso del riel queda. Ningún texto de la página (fuera
    // del eje del gráfico, cuyo «$ 0» es la base de las columnas) es «$ 0».
    expect(screen.queryByText("Efectivo esperado")).not.toBeInTheDocument()
    const ceros = screen.queryAllByText("$ 0").filter((el) => el.closest("svg") === null)
    expect(ceros).toEqual([])
  })

  it("una alerta de tipo conocido (fiscal_range_low) se lista con su enlace correctivo", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        alerts: [
          {
            type: "fiscal_range_low",
            level: "warning",
            title: "Rango por agotarse",
            body: "El rango POS-A está al 80% de consumo.",
            created_at: "2026-09-15T12:00:00Z",
            payload: null,
          },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Rango por agotarse")).toBeInTheDocument())
    expect(noticeLink("Rango por agotarse")).toHaveAttribute("href", "/admin/fiscal/rangos")
  })

  it("un agotado no aparece dos veces (tarjeta directa + alerta product_unavailable)", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        unavailable_products: [{ product_id: 9, name: "Limonada", unavailable_at: "2026-09-15T10:00:00Z", by: null }],
        alerts: [
          {
            type: "product_unavailable",
            level: "info",
            title: "Producto agotado",
            body: "Limonada se marcó agotada.",
            created_at: "2026-09-15T10:00:00Z",
            payload: null,
          },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText(/1 producto agotado/i)).toBeInTheDocument())
    expect(screen.queryByText("Producto agotado")).not.toBeInTheDocument()
  })

  it("insumos «bajo mínimo» y «negativos» son dos alertas distintas (pedido 2a), con enlaces distintos a Stock", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        ingredients_below_min: [{ ingredient_id: 1, name: "Papa criolla", qty_base: 400, min_stock: 1000, base_unit: "g" }],
        ingredients_negative: [
          { ingredient_id: 2, name: "Leche entera", qty_base: -400, min_stock: 2000, base_unit: "ml", negative_since: "2026-09-01T00:00:00Z", probable_cause: null },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    const belowMinTitle = await screen.findByText(/1 insumo bajo el mínimo/i)
    const negativeTitle = await screen.findByText(/1 insumo en negativo/i)
    expect(belowMinTitle).toBeInTheDocument()
    expect(negativeTitle).toBeInTheDocument()

    expect(noticeLink(/1 insumo bajo el mínimo/i)).toHaveAttribute("href", "/admin/inventario?tab=stock&below_min=1")
    expect(noticeLink(/1 insumo en negativo/i)).toHaveAttribute("href", "/admin/inventario?tab=stock&negative=1")
    // El enlace nombra el destino EN PALABRAS, nunca la consulta cruda (§ 6).
    expect(screen.getAllByText("Inventario › Stock")).toHaveLength(2)
    expect(screen.getByText("negativos")).toBeInTheDocument()
    expect(screen.getByText("bajo mínimo")).toBeInTheDocument()
    // "deuda de registro" (negativo) nunca se confunde con "bajo mínimo": textos propios.
    expect(screen.getByText(/deuda de registro/i)).toBeInTheDocument()
    expect(screen.getByText(/reponé pronto/i)).toBeInTheDocument()
  })

  it("preparaciones sin producir y platos sin receta llevan a Preparaciones y a Carta respectivamente", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        preps_without_production: [{ type: "prep_no_production", preparation_id: 5, preparation_name: "Caldo base", current_stock: -200, unit: "ml" }],
        products_discounting_nothing: [{ product_id: 9, product_name: "Sopa del día", items_sold: 3, qty_sold: 3 }],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText(/preparación por lote sin producir/i)
    expect(noticeLink(/preparación por lote sin producir/i)).toHaveAttribute("href", "/admin/preparaciones")
    expect(noticeLink(/plato vendido sin descontar nada/i)).toHaveAttribute("href", "/admin/carta")
  })

  // ---------------------------------------------------------------------
  // Pedido 2b: lotes por vencer/vencidos, cuentas por pagar, salud del
  // control. Con la función apagada el backend manda `[]`/`0`/`null` — la
  // tarjeta no se dibuja (ni vacía, ni con un 0 mudo).
  // ---------------------------------------------------------------------

  it("lotes vencidos con stock se ven distinto (crítico) de los que sólo están por vencer (advertencia), y enlazan a Lotes", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        lots_expiring_or_expired: [
          { batch_id: 1, ingredient_id: 5, qty_base: "800", expires_at: "2026-09-10", status: "expired" },
          { batch_id: 2, ingredient_id: 6, qty_base: "300", expires_at: "2026-09-20", status: "expiring" },
        ],
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText(/2 lotes de insumo por vencer o vencido/i)
    expect(noticeLink(/2 lotes de insumo por vencer o vencido/i)).toHaveAttribute("href", "/admin/inventario?tab=lotes")
    expect(screen.getByText(/1 vencido con stock/)).toBeInTheDocument()
    expect(screen.getByText(/1 por vencer en ≤ 7 días/)).toBeInTheDocument()
  })

  it("sin lotes por vencer ni vencidos, la tarjeta no se dibuja (ni vacía)", async () => {
    getTodayMock.mockResolvedValue(baseToday({ lots_expiring_or_expired: [] }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Todo al día")).toBeInTheDocument())
    expect(screen.queryByText(/lote/i)).not.toBeInTheDocument()
  })

  it("cuentas por pagar vencidas y pendientes de revisión son DOS tarjetas distintas, y enlazan a Compras (otro agente) por URL, no se duplica la pantalla", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        payables_overdue: [
          { payable_id: 1, supplier_id: 1, supplier_name: "Distribuidora La 70", due_date: "2026-09-01", balance: 450000, days_overdue: 14 },
        ],
        payables_pending_review_count: 3,
      }),
    )

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText(/1 cuenta por pagar vencida/i)
    expect(noticeLink(/1 cuenta por pagar vencida/i)).toHaveAttribute("href", "/admin/compras?tab=cuentas-por-pagar")
    expect(screen.getByText(/Distribuidora La 70/)).toBeInTheDocument()

    expect(noticeLink(/3 cuentas por pagar pendientes de revisión/i)).toHaveAttribute(
      "href",
      "/admin/compras?tab=cuentas-por-pagar",
    )
  })

  it("inventario no confiable (2b) NO se dibuja con `null` (función apagada o sin dominio) — nunca se confunde con «no confiable»", async () => {
    getTodayMock.mockResolvedValue(baseToday({ inventory_unreliable: null, days_since_last_full_count: null }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Todo al día")).toBeInTheDocument())
    expect(screen.queryByText("Inventario no confiable")).not.toBeInTheDocument()
  })

  it("inventario no confiable (2b) se dibuja sólo cuando el backend lo AFIRMA (true), con los días y enlace a Salud del control", async () => {
    getTodayMock.mockResolvedValue(baseToday({ inventory_unreliable: true, days_since_last_full_count: 21 }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Inventario no confiable")
    expect(noticeLink("Inventario no confiable")).toHaveAttribute("href", "/admin/inventario?tab=salud")
    expect(screen.getByText(/21 días sin un conteo completo aplicado/)).toBeInTheDocument()
  })

  // ---------------------------------------------------------------------
  // El celular del dueño (`docs/diseno/propuesta.html`, Momento 5): primero
  // la respuesta, después lo que exige actuar, los indicadores al final; y
  // lo que llega `null` dice qué falta.
  // ---------------------------------------------------------------------

  // Cambio intencional (decisión del dueño, 2026-09-29): el orden es el
  // que pidió —venta, ticket promedio, número de tickets, efectivo,
  // tarjeta, ventas por hora, top productos, entradas de mercancía— y
  // «Requiere tu atención» va al final del código: a la derecha en el
  // escritorio, después de todo en el celular.
  it("orden de lectura: la venta, las cuatro cifras, ventas por hora, top productos, entradas y al final «Requiere tu atención»", async () => {
    getTodayMock.mockResolvedValue(baseToday())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const cifra = await screen.findByText("Ventas netas de hoy")
    const orden = [
      cifra,
      screen.getByText("Ticket promedio"),
      screen.getByText("Número de tickets"),
      screen.getByText("Ventas en efectivo"),
      screen.getByText("Ventas en tarjeta"),
      screen.getByRole("region", { name: "Ventas por hora" }),
      screen.getByText("Lo más vendido hoy"),
      screen.getByText("Lo que entró hoy"),
      screen.getByRole("complementary", { name: "Requiere tu atención" }),
    ]
    const antes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    for (let i = 1; i < orden.length; i++) expect(antes(orden[i - 1], orden[i])).toBe(true)
  })

  it("tiempo de cocina hoy: el promedio por estación tal como llega, y el que pasó su objetivo lo dice", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        kitchen_prep_by_station: [
          { station: "hot_kitchen", items: 4, avg_seconds: 630, target_minutes: 10, outside: true },
          { station: "bar", items: 1, avg_seconds: 240, target_minutes: 5, outside: false },
        ],
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const bloque = await screen.findByRole("region", { name: "Tiempo de cocina hoy" })
    expect(within(bloque).getByText("Cocina caliente")).toBeInTheDocument()
    expect(within(bloque).getByText("10 min 30 s")).toBeInTheDocument()
    expect(within(bloque).getByText(/4 platos · objetivo 10 min · pasó el objetivo/)).toBeInTheDocument()
    expect(within(bloque).getByText("4 min")).toBeInTheDocument()
    expect(within(bloque).getByText("1 plato · objetivo 5 min")).toBeInTheDocument()
  })

  it("con «Cocina» apagada (`null`) el bloque de tiempos no se dibuja", async () => {
    getTodayMock.mockResolvedValue(baseToday({ kitchen_prep_by_station: null }))
    renderWithProviders(<TodayPage />, { me: buildMe() })
    await screen.findByText("Ventas netas de hoy")
    expect(screen.queryByRole("region", { name: "Tiempo de cocina hoy" })).not.toBeInTheDocument()
  })

  it("los indicadores que llegan `null` se dibujan como «Sin dato» con lo que falta, nunca como «—» ni «$ 0»", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        orders: 0,
        covers: null,
        avg_ticket: null,
        avg_per_cover: null,
        expected_cash: null,
        net: 0,
        gross: 0,
        tax: 0,
        sales_by_hour: [],
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Ventas netas de hoy")
    // Se busca el motivo y se mira que viva dentro del «sin dato» rayado
    // (`SinDato`): el rótulo de adelante es cosa de ese componente.
    // Cambio intencional (2026-09-29): de las cifras que pueden llegar
    // `null` en Hoy quedan el ticket promedio y el desglose por medio
    // (ticket por comensal, comensales y efectivo esperado salieron).
    expect(screen.getByText(/todavía sin tickets pagados hoy/).closest(".sin-dato")).not.toBeNull()
    const sinDesglose = screen.getAllByText(/sin el desglose por medio de pago/)
    expect(sinDesglose).toHaveLength(2)
    for (const motivo of sinDesglose) expect(motivo.closest(".sin-dato")).not.toBeNull()
    // h1: comensales y promedio por comensal volvieron; `null` es «sin
    // comensales registrados», nunca 0.
    const sinComensales = screen.getAllByText(/sin comensales registrados/)
    expect(sinComensales).toHaveLength(2)
    for (const motivo of sinComensales) expect(motivo.closest(".sin-dato")).not.toBeNull()
    expect(screen.queryByText("—")).not.toBeInTheDocument()
  })

  // Quitado a propósito (decisión del dueño, 2026-09-29): «Ticket por
  // comensal» ya no está en Hoy; su «sin dato» se prueba en Ventas.

  it("no inventa una comparación: un servidor que no manda `comparison` no la muestra", async () => {
    getTodayMock.mockResolvedValue(baseToday())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Ventas netas de hoy")
    expect(screen.queryByText(/pasado a esta hora|semana anterior|%/)).not.toBeInTheDocument()
  })

  it("llegando con #requiere-atencion («Avisos» del celular), el foco queda en «Requiere tu atención»", async () => {
    getTodayMock.mockResolvedValue(baseToday())
    renderWithProviders(<TodayPage />, { me: buildMe(), route: "/admin/hoy#requiere-atencion" })

    const atencion = await screen.findByRole("complementary", { name: "Requiere tu atención" })
    await waitFor(() => expect(document.activeElement).toBe(atencion.parentElement))
    expect(atencion.parentElement).toHaveAttribute("id", "requiere-atencion")
  })

  // ---------------------------------------------------------------------
  // Revisión de datos (sep. 2026): comparación, cierre de ayer, horas que
  // todavía no llegan, el aviso resumen de caja y el orden por plata.
  // ---------------------------------------------------------------------

  it("la cifra rectora se compara con el mismo día de la semana pasada a la misma hora, tal como lo manda el servidor", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        comparison: {
          reference_business_date: "2026-09-08", // martes
          until: "2026-09-08T19:00:00Z",
          net: 82450,
          orders: 4,
          delta_bp: 1230,
          orders_delta_bp: 2500,
          reference_operated: true,
          null_reason: null,
        },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Contra el martes pasado a esta hora")
    // `delta_bp` 1.230 se escribe «▲ 12,3 %»: sólo cambia de unidad.
    expect(screen.getByText(`▲ ${pct(1230)}`)).toBeInTheDocument()
    expect(screen.getByText("entonces $ 82.450")).toBeInTheDocument()
    // El titular del gráfico concluye con la misma cifra, sin calcular otra.
    expect(
      // Sin normalizar: `formatPct` separa la cifra del «%» con espacio fino.
      screen.getByText(`Vas ${formatPct(1230)} arriba del martes pasado a esta hora`, { normalizer: (t) => t }),
    ).toBeInTheDocument()
  })

  it("una variación negativa se escribe «▼» y «abajo», con el valor sin signo", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        comparison: {
          reference_business_date: "2026-09-08",
          until: "2026-09-08T19:00:00Z",
          net: 120000,
          orders: 7,
          delta_bp: -2284,
          orders_delta_bp: null,
          reference_operated: true,
          null_reason: null,
        },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText(`▼ ${pct(2284)}`)
    expect(
      screen.getByText(`Vas ${formatPct(2284)} abajo del martes pasado a esta hora`, { normalizer: (t) => t }),
    ).toBeInTheDocument()
  })

  it("sin contra qué comparar dice por qué: `null` no es «0 %»", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        comparison: {
          reference_business_date: "2026-09-08",
          until: "2026-09-08T19:00:00Z",
          net: null,
          orders: null,
          delta_bp: null,
          orders_delta_bp: null,
          reference_operated: null,
          null_reason: "La sede todavía no operaba el mismo día de la semana pasada: no hay contra qué comparar.",
        },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText(/La sede todavía no operaba el mismo día de la semana pasada/)
    expect(screen.getByText("Sin dato")).toBeInTheDocument()
    expect(screen.queryByText(/0,0\s%/)).not.toBeInTheDocument()
  })

  it("si el mismo día de la semana pasada vendió $ 0 a esta hora, no hay variación (sin divisor), y se dice", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        comparison: {
          reference_business_date: "2026-09-08",
          until: "2026-09-08T19:00:00Z",
          net: 0,
          orders: 0,
          delta_bp: null,
          orders_delta_bp: null,
          reference_operated: false,
          null_reason: null,
        },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("ese día no abrió")
    expect(screen.getByText("Contra el martes pasado a esta hora")).toBeInTheDocument()
    expect(screen.getByText("Sin dato")).toBeInTheDocument()
    expect(screen.queryByText(/▲|▼/)).not.toBeInTheDocument()
  })

  it("antes de la primera venta muestra cómo cerró ayer en vez de un «$ 0» suelto", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        orders: 0,
        net: 0,
        gross: 0,
        tax: 0,
        covers: null,
        avg_ticket: null,
        avg_per_cover: null,
        sales_by_hour: [],
        yesterday_close: { business_date: "2026-09-14", net: 1954300, orders: 31, avg_ticket: 63042, operated: true },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Todavía no hay ventas hoy · ayer cerró en")
    expect(screen.getByText("$ 1.954.300")).toBeInTheDocument()
    // «tickets»: la palabra del dueño para las comandas pagadas (2026-09-29).
    expect(screen.getByText(/lun 14 sep · 31 tickets · ticket promedio \$ 63\.042/)).toBeInTheDocument()
    // El libro sigue siendo el de hoy: lo de hoy es $ 0 de verdad (el día está abierto).
    expect(screen.getByText("Ventas netas de hoy")).toBeInTheDocument()
    // La comparación de hoy contra la semana pasada no va bajo la cifra de
    // otro día: vuelve con la primera venta.
    expect(screen.queryByText(/pasado a esta hora/)).not.toBeInTheDocument()
  })

  it("si ayer la sede no abrió (o no vendió), su $ 0 no se muestra como cierre: queda la cifra de hoy", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        orders: 0,
        net: 0,
        gross: 0,
        tax: 0,
        sales_by_hour: [],
        yesterday_close: { business_date: "2026-09-14", net: 0, orders: 0, avg_ticket: null, operated: false },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Ventas netas de hoy")
    expect(screen.queryByText(/ayer cerró en/)).not.toBeInTheDocument()
  })

  it("si ayer no vendió, muestra el último día con ventas en vez de un «$ 0» suelto", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        orders: 0,
        net: 0,
        gross: 0,
        tax: 0,
        sales_by_hour: [],
        yesterday_close: { business_date: "2026-09-28", net: 0, orders: 0, avg_ticket: null, operated: false },
        last_sales_close: { business_date: "2026-09-27", net: 3073500, orders: 40, avg_ticket: 76838, operated: true },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Todavía no hay ventas hoy · el último día con ventas cerró en")
    expect(screen.getByText("$ 3.073.500")).toBeInTheDocument()
    expect(screen.getByText(/dom 27 sep · 40 tickets/)).toBeInTheDocument()
  })

  it("antes de la primera venta, los bloques repasan ayer: tickets, medios, platos y entradas", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        orders: 0,
        net: 0,
        gross: 0,
        tax: 0,
        avg_ticket: null,
        sales_by_hour: [],
        top_products: [],
        receptions_today: [],
        yesterday_close: { business_date: "2026-09-29", net: 1682200, orders: 30, avg_ticket: 56073, operated: true },
        recap: {
          business_date: "2026-09-29",
          is_yesterday: true,
          orders: 30,
          avg_ticket: 56073,
          net: 1682200,
          cash_sales: { net: 655000, gross: 700000, payments: 14 },
          card_sales: { net: 872200, gross: 930000, payments: 12 },
          other_payment_sales: { net: 155000, gross: 165000, payments: 4 },
          sales_by_hour: [],
          top_products: [{ key: "1", label: "Bandeja paisa", units: 9, net: 342000, share_bp: null }],
          receptions: [],
        },
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    expect(await screen.findByText(/estas cifras y los bloques de abajo son de/)).toBeInTheDocument()
    expect(screen.getByText("Lo más vendido · Ayer")).toBeInTheDocument()
    expect(screen.getByText("Bandeja paisa")).toBeInTheDocument()
    expect(screen.getByText("30")).toBeInTheDocument()
    expect(screen.getByText("$ 655.000")).toBeInTheDocument()
    const descarga = screen.getAllByRole("link", { name: /Descargar CSV/ }).map((a) => a.getAttribute("href"))
    expect(descarga.some((h) => h?.includes("top-products") && h.includes("date=2026-09-29"))).toBe(true)
  })

  it("ventas por hora sin una sola venta: la pregunta y una línea, sin eje vacío ni horas rayadas", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        orders: 0,
        net: 0,
        gross: 0,
        tax: 0,
        sales_by_hour: [
          { hour: 6, gross: 0, net: 0, orders: 0, pending: false },
          { hour: 7, gross: 0, net: 0, orders: 0, pending: false },
          { hour: 8, gross: 0, net: 0, orders: 0, pending: true },
        ],
        sales_by_hour_reference: [],
        comparison: {
          reference_business_date: "2026-09-08",
          until: "2026-09-08T12:00:00Z",
          net: 0,
          orders: 0,
          delta_bp: null,
          orders_delta_bp: null,
          reference_operated: false,
          null_reason: null,
        },
      }),
    )
    const { container } = renderWithProviders(<TodayPage />, { me: buildMe() })

    expect(await screen.findByText("Todavía no hay ventas hoy; el martes pasado a esta hora tampoco.")).toBeInTheDocument()
    const bloque = container.querySelector('[data-slot="ventas-por-hora-vacio"]') as HTMLElement
    expect(bloque.querySelector("svg")).toBeNull()
    expect(bloque.querySelector("[data-hueco]")).toBeNull()
  })

  it("ventas por hora: columnas en el orden en que llegan, una hora `pending` es hueco (no $ 0) y la semana pasada va de referencia", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        sales_by_hour: [
          { hour: 11, gross: 0, net: 0, orders: 0, pending: false },
          { hour: 12, gross: 100000, net: 92593, orders: 3, pending: false },
          { hour: 13, gross: 0, net: 0, orders: 0, pending: true },
          { hour: 0, gross: 0, net: 0, orders: 0, pending: true },
        ],
        sales_by_hour_reference: [
          { hour: 11, gross: 20000, net: 18519, orders: 1, pending: false },
          { hour: 12, gross: 80000, net: 74074, orders: 2, pending: false },
          { hour: 13, gross: 60000, net: 55556, orders: 2, pending: false },
          { hour: 0, gross: 0, net: 0, orders: 0, pending: false },
        ],
        comparison: {
          reference_business_date: "2026-09-08",
          until: "2026-09-08T17:00:00Z",
          net: 92593,
          orders: 3,
          delta_bp: 0,
          orders_delta_bp: 0,
          reference_operated: true,
          null_reason: null,
        },
      }),
    )
    const { container } = renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Vas igual que el martes pasado a esta hora")
    // La hora con 0 real es columna con dato; las que todavía no llegan van
    // como columna clara a todo el alto («Burbujas»), nunca como $ 0.
    const pendiente = (h: string) => container.querySelector(`[data-columna="${h}"] [data-pendiente]`)
    expect(container.querySelector('[data-columna="11"]')).not.toBeNull()
    expect(pendiente("11")).toBeNull()
    expect(pendiente("13")).not.toBeNull()
    // Las 11 van antes que las 13 (orden del día operativo, como llegan).
    const col11 = container.querySelector('[data-columna="11"]') as Element
    const col13 = container.querySelector('[data-columna="13"]') as Element
    expect(col11.compareDocumentPosition(col13) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Como en el diseño, sólo las horas en que la sede opera: las 00 no
    // tuvieron venta ni hoy ni la semana pasada y quedan fuera.
    expect(container.querySelector('[data-columna="0"]')).toBeNull()
    // Una raya de referencia por hora con dato.
    expect(container.querySelectorAll("[data-referencia]")).toHaveLength(3)
    expect(screen.getByText(/Columna clara: horas que todavía no llegan/)).toBeInTheDocument()
  })

  it("el aviso resumen de caja lleva a Dinero › Historial, dice la plata en juego y quién lleva racha", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        alerts: [
          {
            type: "cash_diff_summary",
            level: "warning",
            title: "8 cierres de caja con diferencia",
            body: "Faltante -$ 68.000 en 8 cierres. En los últimos 14 días.",
            created_at: "2026-09-15T03:00:00Z",
            amount: -68000,
            payload: {
              count: 8,
              shortage_count: 8,
              shortage_total: -68000,
              surplus_count: 0,
              surplus_total: 0,
              net_total: -68000,
              critical_count: 0,
              shift_ids: [1, 2, 3, 4, 5, 6, 7, 8],
              first_business_date: "2026-09-02",
              last_business_date: "2026-09-14",
              days: 14,
              streaks: [{ employee_id: 7, employee_name: "Luz Marina Gómez", streak: 3 }],
            },
          },
        ],
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("8 cierres de caja con diferencia")
    expect(noticeLink("8 cierres de caja con diferencia")).toHaveAttribute("href", "/admin/dinero?tab=historial")
    expect(screen.getByText("Dinero › Historial")).toBeInTheDocument()
    const item = screen.getByText("8 cierres de caja con diferencia").closest("li") as HTMLElement
    // La palabra dice el signo: «faltan $ 68.000», no «-$ 68.000 faltante».
    expect(within(item).getByText("faltan $ 68.000")).toBeInTheDocument()
    expect(within(item).getByText(/Racha: Luz Marina Gómez, 3 cierres seguidos\./)).toBeInTheDocument()
  })

  it("los avisos van por gravedad y, dentro de cada una, por plata en juego; el monto se ve en cada uno que lo tiene", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        alerts: [
          { type: "waste_spike", level: "warning", title: "Merma alta", body: "Cilantro.", created_at: "2026-09-15T10:00:00Z", payload: null, amount: null },
          { type: "cash_over_threshold", level: "warning", title: "Caja chica", body: "Poco.", created_at: "2026-09-15T10:00:00Z", payload: null, amount: 5000 },
          { type: "cash_over_threshold", level: "warning", title: "Caja grande", body: "Mucho.", created_at: "2026-09-15T11:00:00Z", payload: null, amount: 900000 },
        ],
        payables_overdue: [
          { payable_id: 1, supplier_id: 1, supplier_name: "Distribuidora La 70", due_date: "2026-09-01", balance: 450000, days_overdue: 14 },
          { payable_id: 2, supplier_id: 2, supplier_name: "Lácteos del Valle", due_date: "2026-09-03", balance: 1050506, days_overdue: 12 },
        ],
        payables_overdue_total: 1500506,
        ingredients_negative: [
          { ingredient_id: 2, name: "Leche entera", qty_base: -400, min_stock: 2000, base_unit: "ml", negative_since: null, probable_cause: null, amount: 1600 },
        ],
        ingredients_negative_amount: 65963,
        ingredients_negative_unvalued: 1,
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Caja grande")
    const titulos = within(screen.getByRole("complementary", { name: "Requiere tu atención" }))
      .getAllByRole("listitem")
      .map((li) => li.querySelector("p")?.textContent)
    // Críticos (cuentas vencidas $ 1.500.506 antes que insumos $ 65.963), y
    // después los de atención de mayor a menor plata; el que no es de plata, al final.
    expect(titulos).toEqual([
      "2 cuentas por pagar vencidas",
      "1 insumo en negativo",
      "Caja grande",
      "Caja chica",
      "Merma alta",
    ])
    // El total vencido lo suma el servidor; acá sólo se escribe.
    const vencidas = screen.getByText("2 cuentas por pagar vencidas").closest("li") as HTMLElement
    expect(within(vencidas).getByText("$ 1.500.506")).toBeInTheDocument()
    const negativos = screen.getByText("1 insumo en negativo").closest("li") as HTMLElement
    expect(within(negativos).getByText("$ 65.963")).toBeInTheDocument()
    expect(within(negativos).getByText(/1 sin costo todavía/)).toBeInTheDocument()
    // Un aviso sin monto no dibuja «$ 0».
    const merma = screen.getByText("Merma alta").closest("li") as HTMLElement
    expect(merma.querySelector("[data-notice-amount]")).toBeNull()
  })

  // Quitado a propósito (decisión del dueño, 2026-09-29): la tabla de
  // comandas abiertas salió de Hoy; vive en la pestaña Pedidos, al lado.

  // ---------------------------------------------------------------------
  // «Orden y aire»: cinco avisos a la vista y la explicación plegada.
  // ---------------------------------------------------------------------
  it("«Requiere tu atención» deja cinco avisos a la vista y el resto detrás de «Ver n más», sin mentir en los recuentos", async () => {
    const alerta = (i: number) => ({
      type: "waste_spike",
      level: "warning",
      title: `Aviso ${i}`,
      body: "Cuerpo.",
      created_at: `2026-09-15T1${i}:00:00Z`,
      payload: null,
      amount: null,
    })
    getTodayMock.mockResolvedValue(baseToday({ alerts: [1, 2, 3, 4, 5, 6, 7].map(alerta) }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const riel = await screen.findByRole("complementary", { name: "Requiere tu atención" })
    // Los recuentos —el del encabezado y el del grupo «Aviso»— son los de
    // todos, no los de los que se ven.
    expect(within(riel).getAllByText("7")).toHaveLength(2)
    const ocultos = () =>
      within(riel)
        .getAllByRole("listitem")
        .filter((li) => li.classList.contains("hidden"))
        .map((li) => li.querySelector("p")?.textContent)
    expect(ocultos()).toEqual(["Aviso 6", "Aviso 7"])

    // Un solo botón, dentro del riel: no uno del riel y otro de la pantalla.
    expect(within(riel).getAllByRole("button", { name: /^Ver / })).toHaveLength(1)
    await userEvent.click(within(riel).getByRole("button", { name: "Ver 2 más" }))
    expect(ocultos()).toEqual([])
    expect(within(riel).getByRole("button", { name: "Ver menos" })).toHaveAttribute("aria-expanded", "true")
  })

  it("con cinco avisos o menos no hay «Ver n más»", async () => {
    getTodayMock.mockResolvedValue(baseToday({ unsent_count: 1, unreviewed_closes_count: 2 }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("Comandas atascadas")
    expect(screen.queryByRole("button", { name: /^Ver \d+ más$/ })).not.toBeInTheDocument()
  })

  it("lo que explica va plegado (pie de tarjetas, método del gráfico, porqué de un aviso); el motivo de un «sin dato» no", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        avg_per_cover: null,
        covers: 0,
        ingredients_negative: [
          { ingredient_id: 2, name: "Leche entera", qty_base: -400, min_stock: 2000, base_unit: "ml", negative_since: null, probable_cause: null, amount: 1600 },
        ],
        ingredients_negative_amount: 1600,
      }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("1 insumo en negativo")
    expect(screen.getByText(/cobradas y cerradas hoy: ya no cambian/).closest("details")).not.toBeNull()
    // El método del gráfico se lee con lector de pantalla; a la vista queda
    // el gráfico solo, como en el diseño («Burbujas»).
    expect(screen.getByText(/Venta neta por hora de reloj/)).toHaveClass("sr-only")
    expect(screen.getByText(/Es deuda de registro/).closest("details")).not.toBeNull()
    // Que la propina no es venta (Ley 1935 de 2018) va plegado con las cifras.
    expect(screen.getByText(/Ley 1935 de 2018/).closest("details")).not.toBeNull()
    // null ≠ 0: el motivo queda a la vista, dentro del rayado.
    const motivo = screen.getAllByText(/sin el desglose por medio de pago/)[0]
    expect(motivo.closest("details")).toBeNull()
    expect(motivo.closest(".sin-dato")).not.toBeNull()
  })
})

describe("TodayPage — consignar desde el POS (2026-09-24)", () => {
  function noticeItem(title: RegExp | string): HTMLElement {
    const item = screen.getByText(title).closest("li")
    expect(item).not.toBeNull()
    return item as HTMLElement
  }

  it("avisa de las consignaciones por confirmar (aviso) y lleva a Banco › Consignaciones", async () => {
    getTodayMock.mockResolvedValue(baseToday({ deposits_to_confirm_count: 2 }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await screen.findByText("2 consignaciones por confirmar")
    expect(noticeLink("2 consignaciones por confirmar")).toHaveAttribute("href", "/admin/banco?tab=consignaciones")
    expect(noticeItem("2 consignaciones por confirmar")).toHaveAttribute("data-severity", "warning")
  })

  it("avisa de la plata sin consignar con el total del SERVIDOR y la fecha más vieja; aviso si tiene ≤ 3 días", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({ business_date: "2026-09-15", undeposited_total: 350_000, undeposited_oldest_date: "2026-09-13" }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const title = /\$ 350\.000 sin consignar desde el dom 13 sep/
    await screen.findByText(title)
    expect(noticeLink(title)).toHaveAttribute("href", "/admin/banco?tab=por-consignar")
    expect(noticeItem(title)).toHaveAttribute("data-severity", "warning")
  })

  it("con más de 3 días sin consignar, el aviso pasa a crítico", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({ business_date: "2026-09-15", undeposited_total: 350_000, undeposited_oldest_date: "2026-09-11" }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const title = /\$ 350\.000 sin consignar desde el/
    await screen.findByText(title)
    expect(noticeItem(title)).toHaveAttribute("data-severity", "critical")
  })

  it("con Consignaciones apagada (0 y null) no hay ninguno de los dos avisos, ni un «$ 0»", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({ deposits_to_confirm_count: 0, undeposited_total: null, undeposited_oldest_date: null }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getByText("Todo al día")).toBeInTheDocument())
    expect(screen.queryByText(/por confirmar/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/sin consignar/i)).not.toBeInTheDocument()
  })
})
