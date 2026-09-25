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
    expect(screen.getByText(/2\/8/)).toBeInTheDocument() // mesas ocupadas
    expect(screen.getByText("Todo al día")).toBeInTheDocument()
  })

  it("«sin turno abierto» aparece cuando expected_cash es null, nunca como $0", async () => {
    getTodayMock.mockResolvedValue(baseToday({ expected_cash: null }))

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText("Sin turno abierto").length).toBeGreaterThan(0))
    // La tarjeta de efectivo dice qué falta; ningún texto de la página (fuera
    // del eje del gráfico, cuyo «$ 0» es la base de las columnas) es «$ 0».
    const efectivo = screen.getByText("Efectivo esperado").closest("div.rounded-lg") as HTMLElement
    expect(within(efectivo).queryByText("$ 0")).not.toBeInTheDocument()
    expect(within(efectivo).getByText(/no hay un turno de caja abierto/).closest(".sin-dato")).not.toBeNull()
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

  it("orden de lectura: la cifra rectora, después «Requiere tu atención», después los indicadores", async () => {
    getTodayMock.mockResolvedValue(baseToday())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const cifra = await screen.findByText("Ventas netas de hoy")
    const atencion = screen.getByRole("complementary", { name: "Requiere tu atención" })
    const indicador = screen.getByText("Ticket promedio")
    const tabla = screen.getByText("Ventas por hora")
    const antes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    expect(antes(cifra, atencion)).toBe(true)
    expect(antes(atencion, indicador)).toBe(true)
    expect(antes(indicador, tabla)).toBe(true)
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
    const sinComandas = screen.getAllByText(/todavía sin comandas pagadas/)
    expect(sinComandas).toHaveLength(3)
    for (const motivo of sinComandas) expect(motivo.closest(".sin-dato")).not.toBeNull()
    expect(screen.getByText(/no hay un turno de caja abierto/).closest(".sin-dato")).not.toBeNull()
    expect(screen.queryByText("—")).not.toBeInTheDocument()
  })

  it("con comandas pagadas pero sin comensales contados, el ticket por comensal dice eso", async () => {
    getTodayMock.mockResolvedValue(baseToday({ covers: 0, avg_per_cover: null }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const motivo = await screen.findByText(/ninguna comanda pagada hoy registró comensales/)
    expect(motivo.closest(".sin-dato")).not.toBeNull()
  })

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
      screen.getByRole("heading", { name: `Vas ${formatPct(1230)} arriba del martes pasado a esta hora` }),
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
      screen.getByRole("heading", { name: `Vas ${formatPct(2284)} abajo del martes pasado a esta hora` }),
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
    expect(screen.getByText(/lun 14 sep · 31 comandas pagadas · ticket promedio \$ 63\.042/)).toBeInTheDocument()
    // El libro sigue siendo el de hoy: lo de hoy es $ 0 de verdad (el día está abierto).
    expect(screen.getByText("Ventas netas de hoy")).toBeInTheDocument()
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

    await screen.findByRole("heading", { name: "Vas igual que el martes pasado a esta hora" })
    // La hora con 0 real es columna; las que todavía no llegan son hueco.
    expect(container.querySelector('[data-columna="11"]')).not.toBeNull()
    expect(container.querySelector('[data-hueco="11"]')).toBeNull()
    expect(container.querySelector('[data-hueco="13"]')).not.toBeNull()
    expect(container.querySelector('[data-columna="13"]')).toBeNull()
    expect(container.querySelector('[data-hueco="0"]')).not.toBeNull()
    // Las 00 van después de las 13 (orden del día operativo, como llegan).
    const hueco13 = container.querySelector('[data-hueco="13"]') as Element
    const hueco0 = container.querySelector('[data-hueco="0"]') as Element
    expect(hueco13.compareDocumentPosition(hueco0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Una marca de referencia por hora con dato (4: la de las 00 es $ 0 real).
    expect(container.querySelectorAll("[data-referencia-serie]")).toHaveLength(4)
    expect(screen.getByText(/Rayado: horas que todavía no llegan/)).toBeInTheDocument()
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

  it("comandas abiertas: el tiempo en horas y minutos, y marca las que vienen del día anterior", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({
        business_date: "2026-09-15",
        yesterday_close: { business_date: "2026-09-14", net: 100000, orders: 3, avg_ticket: 33333, operated: true },
        open_orders: [
          // 22:00 del 14 en Bogotá (03:00 UTC del 15): con corte a las 3, es del 14.
          { id: 458, channel: "dine_in", tables: ["1"], opened_at: "2026-09-15T03:00:00Z", minutes_since_opened: 968, total: 80000 },
          // 12:00 del 15 en Bogotá: es de hoy.
          { id: 461, channel: "dine_in", tables: ["2"], opened_at: "2026-09-15T17:00:00Z", minutes_since_opened: 45, total: 20000 },
        ],
      }),
    )
    renderWithProviders(<TodayPage />, {
      me: buildMe({ store: { id: 1, name: "Sede Centro", cutoff_hour: 3, active_channels: [] } }),
    })

    await screen.findByText("16 h 8 min")
    expect(screen.queryByText("968 min")).not.toBeInTheDocument()
    expect(screen.getByText("45 min")).toBeInTheDocument()
    expect(screen.getAllByText("Viene de ayer")).toHaveLength(1)
    const fila458 = screen.getByText("#458").closest("tr") as HTMLElement
    expect(within(fila458).getByText("Viene de ayer")).toBeInTheDocument()
  })

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
    expect(screen.getByText(/cobradas y cerradas: ya no cambian/).closest("details")).not.toBeNull()
    expect(screen.getByText(/Venta neta por hora de reloj/).closest("details")).not.toBeNull()
    expect(screen.getByText(/Es deuda de registro/).closest("details")).not.toBeNull()
    // La propina: que no es venta se ve; la ley, plegada.
    expect(screen.getByText("No son venta.").closest("details")).toBeNull()
    expect(screen.getByText(/Ley 1935 de 2018/).closest("details")).not.toBeNull()
    // null ≠ 0: el motivo queda a la vista, dentro del rayado.
    const motivo = screen.getByText(/ninguna comanda pagada hoy registró comensales/)
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
    expect(noticeItem("2 consignaciones por confirmar").className).toContain("border-l-warning")
  })

  it("avisa de la plata sin consignar con el total del SERVIDOR y la fecha más vieja; aviso si tiene ≤ 3 días", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({ business_date: "2026-09-15", undeposited_total: 350_000, undeposited_oldest_date: "2026-09-13" }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const title = /\$ 350\.000 sin consignar desde el dom 13 sep/
    await screen.findByText(title)
    expect(noticeLink(title)).toHaveAttribute("href", "/admin/banco?tab=por-consignar")
    expect(noticeItem(title).className).toContain("border-l-warning")
  })

  it("con más de 3 días sin consignar, el aviso pasa a crítico", async () => {
    getTodayMock.mockResolvedValue(
      baseToday({ business_date: "2026-09-15", undeposited_total: 350_000, undeposited_oldest_date: "2026-09-11" }),
    )
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const title = /\$ 350\.000 sin consignar desde el/
    await screen.findByText(title)
    expect(noticeItem(title).className).toContain("border-l-destructive")
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
