/**
 * «Hoy» según el dueño (2026-09-29): efectivo y tarjeta, top de productos y
 * entradas de mercancía con su lote, cada bloque con su descarga del
 * servidor. La pantalla sólo escribe lo que llega: ninguna cifra se suma ni
 * se reparte acá.
 */
import { screen, within } from "@testing-library/react"
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

function today(overrides: Record<string, unknown> = {}) {
  return {
    store_id: 1,
    business_date: "2026-09-29",
    sales_by_hour: [{ hour: 12, gross: 108000, net: 100000, orders: 3 }],
    gross: 108000,
    net: 100000,
    tax: 8000,
    tips_total: 0,
    tips_by_method: [],
    orders: 3,
    covers: null,
    avg_ticket: 33333,
    avg_per_cover: null,
    tables_occupied: 0,
    tables_total: 0,
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
    // Los números NO cierran a propósito (61.111 + 27.777 ≠ 100.000 − 11.112):
    // si la pantalla sumara o repartiera algo, la prueba lo vería.
    cash_sales: { net: 61111, gross: 66000, payments: 2 },
    card_sales: { net: 27777, gross: 30000, payments: 1 },
    other_payment_sales: { net: 11112, gross: 12000, payments: 1 },
    top_products: [
      { key: "p:1", label: "Bandeja paisa", units: 2, net: 55556, share_bp: 5556 },
      { key: "p:2", label: "Limonada de coco", units: 4, net: 44444, share_bp: 4444 },
    ],
    receptions_enabled: true,
    receptions_today: [
      {
        reception_id: 7,
        line_id: 70,
        received_at: "2026-09-29T15:05:00Z",
        supplier_name: "Avícola El Dorado",
        ingredient_id: 3,
        ingredient_name: "Pechuga de pollo",
        qty: "2.5",
        purchase_unit: "kg",
        lot_code: "L-0301",
        expires_at: "2026-10-02",
        days_to_expiry: 3,
        lot_status: "expiring",
        received_by: "Luz Marina",
      },
      {
        reception_id: 7,
        line_id: 71,
        received_at: "2026-09-29T15:05:00Z",
        supplier_name: "Avícola El Dorado",
        ingredient_id: 4,
        ingredient_name: "Huevo AA",
        qty: "30",
        purchase_unit: "und",
        lot_code: null,
        expires_at: null,
        days_to_expiry: null,
        lot_status: null,
        received_by: "Luz Marina",
      },
    ],
    ...overrides,
  }
}

describe("Hoy · lo que pidió el dueño", () => {
  it("efectivo y tarjeta son las cifras del servidor, y los otros medios se dicen aparte", async () => {
    getTodayMock.mockResolvedValue(today())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const efectivo = (await screen.findByText("Ventas en efectivo")).closest("div.rounded-lg") as HTMLElement
    expect(within(efectivo).getByText("$ 61.111")).toBeInTheDocument()
    expect(within(efectivo).getByText("2 pagos")).toBeInTheDocument()
    const tarjeta = screen.getByText("Ventas en tarjeta").closest("div.rounded-lg") as HTMLElement
    expect(within(tarjeta).getByText("$ 27.777")).toBeInTheDocument()
    expect(within(tarjeta).getByText("1 pago")).toBeInTheDocument()
    expect(screen.getByText("$ 11.112")).toBeInTheDocument()
    const tickets = screen.getByText("Número de tickets").closest("div.rounded-lg") as HTMLElement
    expect(within(tickets).getByText("3")).toBeInTheDocument()
    expect(screen.getByText("$ 33.333")).toBeInTheDocument()
  })

  it("top productos: el orden y las cifras del servidor, con su descarga", async () => {
    getTodayMock.mockResolvedValue(today())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const bloque = (await screen.findByText("Top productos vendidos")).closest("section") as HTMLElement
    const filas = within(bloque).getAllByRole("row").slice(1)
    expect(filas.map((f) => within(f).getAllByRole("cell").map((c) => c.textContent))).toEqual([
      ["Bandeja paisa", "2", "$ 55.556"],
      ["Limonada de coco", "4", "$ 44.444"],
    ])
    expect(within(bloque).getByRole("link", { name: /Descargar CSV/ })).toHaveAttribute(
      "href",
      "/api/v1/admin/today/top-products?store_id=1&format=csv",
    )
  })

  it("entradas de mercancía: proveedor, cantidad en unidad de compra, lote, vencimiento, quién recibió; el que vence pronto resaltado", async () => {
    getTodayMock.mockResolvedValue(today())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const bloque = (await screen.findByText("Entradas de mercancía")).closest("section") as HTMLElement
    const pollo = within(bloque).getByText("Pechuga de pollo").closest("tr") as HTMLElement
    expect(pollo).toHaveAttribute("data-status", "warning")
    expect(within(pollo).getByText("Avícola El Dorado")).toBeInTheDocument()
    expect(within(pollo).getByText("2.5 kg")).toBeInTheDocument()
    expect(within(pollo).getByText("L-0301")).toBeInTheDocument()
    expect(within(pollo).getByText(/vence en 3 días/)).toBeInTheDocument()
    expect(within(pollo).getByText("Luz Marina")).toBeInTheDocument()
    const huevo = within(bloque).getByText("Huevo AA").closest("tr") as HTMLElement
    expect(huevo).toHaveAttribute("data-status", "none")
    expect(within(huevo).getByText("sin lote")).toBeInTheDocument()
    expect(within(bloque).getByText(/1 lote vence pronto/)).toBeInTheDocument()
    expect(within(bloque).getByRole("link", { name: /Descargar CSV/ })).toHaveAttribute(
      "href",
      "/api/v1/admin/today/receptions?store_id=1&format=csv",
    )
  })

  it("ventas por hora se descarga del servidor", async () => {
    getTodayMock.mockResolvedValue(today())
    renderWithProviders(<TodayPage />, { me: buildMe() })

    const bloque = (await screen.findByText("Ventas por hora")).closest("section") as HTMLElement
    expect(within(bloque).getByRole("link", { name: /Descargar CSV/ })).toHaveAttribute(
      "href",
      "/api/v1/admin/today/sales-by-hour?store_id=1&format=csv",
    )
  })

  it("sin «Compras» no dice «no entró nada»: dice que la función está apagada", async () => {
    getTodayMock.mockResolvedValue(today({ receptions_enabled: false, receptions_today: [] }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    expect(await screen.findByText(/«Compras» está apagada en esta sede/)).toBeInTheDocument()
    expect(screen.queryByText("Hoy no entró mercancía")).not.toBeInTheDocument()
  })

  it("sin ventas ni entradas, cada bloque lo dice con calma", async () => {
    getTodayMock.mockResolvedValue(today({ top_products: [], receptions_today: [] }))
    renderWithProviders(<TodayPage />, { me: buildMe() })

    expect(await screen.findByText("Todavía no se vendió nada hoy")).toBeInTheDocument()
    expect(screen.getByText("Hoy no entró mercancía")).toBeInTheDocument()
  })
})
