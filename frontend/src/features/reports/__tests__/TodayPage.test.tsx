import { screen, waitFor, within } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

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
    expect(screen.queryByText("$ 0")).not.toBeInTheDocument()
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
})
