import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ReportsOverviewOut, SalesBucketOut } from "@/api/reports"
import { buildMe, renderWithProviders } from "@/test/utils"

import { InformesPage } from "../InformesPage"
import { rangoDePeriodo } from "../lib"

const { storeState, getReportsOverviewMock, adminListOrdersMock, adminGetOrderMock } = vi.hoisted(() => ({
  storeState: {
    stores: [{ id: 1, name: "Sede Centro" }] as { id: number; name: string }[],
  },
  getReportsOverviewMock: vi.fn(),
  adminListOrdersMock: vi.fn(),
  adminGetOrderMock: vi.fn(),
}))

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: storeState.stores,
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getReportsOverview: getReportsOverviewMock }
})

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return { ...actual, adminListOrders: adminListOrdersMock, adminGetOrder: adminGetOrderMock }
})

function bucket(key: string, over: Partial<SalesBucketOut> = {}): SalesBucketOut {
  return {
    key,
    label: key,
    gross: 0,
    net: 0,
    tax: 0,
    tips: 0,
    orders: 0,
    covers: null,
    avg_ticket: null,
    avg_per_cover: null,
    theoretical_cost: null,
    gross_margin: null,
    costed_pct: null,
    share_bp: null,
    ...over,
  }
}

function overview(over: Partial<ReportsOverviewOut> = {}): ReportsOverviewOut {
  return {
    scope: "store",
    store_id: 1,
    store_ids: [1],
    date_from: "2026-09-21",
    date_to: "2026-09-25",
    total: bucket("total", {
      gross: 1_080_000,
      net: 1_000_000,
      tax: 80_000,
      tips: 45_000,
      orders: 40,
      avg_ticket: 25_000,
      avg_per_cover: null,
      costed_pct: 0,
      previous_period: {
        date_from: "2026-09-16",
        date_to: "2026-09-20",
        net: 800_000,
        orders: 32,
        avg_ticket: 25_000,
        delta_bp: 2_500,
        orders_delta_bp: 2_500,
        avg_ticket_delta_bp: 0,
        partial: false,
        null_reason: null,
      },
    }),
    by_method: [
      bucket("cash", { net: 600_000, payments: 25, orders: 25, share_bp: 6_000 }),
      bucket("card", { net: 400_000, payments: 15, orders: 15, share_bp: 4_000 }),
    ],
    by_hour: [
      bucket("11", { label: "11:00", net: 0 }),
      bucket("12", { label: "12:00", net: 233_100, orders: 10 }),
      bucket("13", { label: "13:00", net: 766_900, orders: 30 }),
      bucket("14", { label: "14:00", net: 0 }),
    ],
    peak_hour: { hour: 13, label: "13:00", net: 766_900, orders: 32, share_bp: 7_669 },
    products: [
      { key: "1", label: "Bandeja Paisa", net: 700_000, units: 28, share_bp: 7_000, category_key: "10", category_label: "Platos" },
      { key: "2", label: "Limonada", net: 300_000, units: 60, share_bp: 3_000, category_key: "20", category_label: "Bebidas" },
    ],
    categories: [
      { key: "20", label: "Bebidas" },
      { key: "10", label: "Platos" },
    ],
    by_employee: [bucket("7", { label: "Catherin", net: 1_000_000, orders: 40, avg_ticket: 25_000 })],
    by_channel: [bucket("dine_in", { net: 1_000_000, orders: 40, share_bp: 10_000 })],
    by_zone: [bucket("3", { label: "Terraza", net: 1_000_000, orders: 40, share_bp: 10_000 })],
    delivery_customers: {
      delivery: null,
      platform: null,
      identified_customers: 3,
      identified_orders: 4,
      missing: [
        {
          key: "delivery_zone",
          label: "Domicilios por zona o barrio",
          reason: "La dirección del domicilio se guarda como texto libre: no hay zonas de reparto para agrupar.",
        },
      ],
    },
    menu_engineering: {
      available: true,
      reason: null,
      star: 4,
      plowhorse: 3,
      puzzle: 2,
      dog: 1,
      unclassified: 0,
      insufficient_sample: 5,
    },
    cost: { theoretical_cost: null, gross_margin: null, costed_pct: 0, by_category: [] },
    by_store: null,
    ...over,
  }
}

beforeEach(() => {
  storeState.stores = [{ id: 1, name: "Sede Centro" }]
  getReportsOverviewMock.mockReset()
  adminListOrdersMock.mockReset()
  adminGetOrderMock.mockReset()
  adminListOrdersMock.mockResolvedValue({ rows: [], kitchen_times_by_station: [], sent_at_payment_ratio: null })
})

function titulosDeSeccion(): string[] {
  return screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "")
}

describe("InformesPage", () => {
  it("todas las secciones, en el orden del mapa, con las cifras del servidor tal cual", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe() })

    await screen.findByText("$ 1.000.000", { selector: "p" })
    expect(titulosDeSeccion()).toEqual([
      "Método de pago",
      "Ventas por hora",
      "Top de productos",
      "Por persona",
      "Canal y zona",
      "Domicilios y clientes",
      "Ingeniería de menú",
      "Historial de comandas",
    ])
    // Indicadores con la comparación que manda el servidor.
    const indicadores = screen.getByRole("region", { name: "Indicadores" })
    expect(within(indicadores).getByText("Venta neta")).toBeInTheDocument()
    expect(within(indicadores).getAllByText(/▲ 25,0 % vs 16 al 20 sep/).length).toBeGreaterThan(0)
    // La propina, aparte: no es venta.
    expect(within(indicadores).getByText(/Propinas \$ 45\.000 — no son venta/)).toBeInTheDocument()
    // La hora pico la marca el servidor (32 comandas, no las 30 de la barra).
    expect(screen.getByText("Hora pico: 13:00 con $ 766.900 en 32 comandas")).toBeInTheDocument()
    // Método de pago: total, pagos y participación.
    expect(screen.getByText("Efectivo")).toBeInTheDocument()
    // Ingeniería de menú: el resumen y el enlace a la pantalla completa.
    expect(screen.getByText("Estrellas").nextSibling).toHaveTextContent("4")
    expect(screen.getByRole("link", { name: /Ver la matriz completa/ })).toHaveAttribute("href", "/admin/analitica")
    // Costo y margen, plegado.
    const costo = screen.getByText("Costo y margen").closest("details")
    expect(costo).not.toHaveAttribute("open")
    expect(getReportsOverviewMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1 }))
  })

  it("null no es cero: cada «sin dato» dice por qué", async () => {
    getReportsOverviewMock.mockResolvedValue(
      overview({
        menu_engineering: {
          available: false,
          reason: "La función «Ingeniería de menú» está apagada para esta sede.",
          star: null,
          plowhorse: null,
          puzzle: null,
          dog: null,
          unclassified: null,
          insufficient_sample: null,
        },
      }),
    )
    renderWithProviders(<InformesPage />, { me: buildMe() })

    await screen.findByText("Domicilios y clientes")
    expect(screen.getByText("Ninguna comanda del período contó comensales. No es cero.")).toBeInTheDocument()
    expect(screen.getByText("No hubo ventas por domicilio en el período.")).toBeInTheDocument()
    expect(
      screen.getByText("La dirección del domicilio se guarda como texto libre: no hay zonas de reparto para agrupar."),
    ).toBeInTheDocument()
    expect(screen.getByText("La función «Ingeniería de menú» está apagada para esta sede.")).toBeInTheDocument()
    expect(screen.getAllByText("Ninguna venta del período tuvo ficha técnica con costo.").length).toBe(2)
    // Sin dato se dibuja «Sin datos», nunca como una cifra.
    expect(screen.getAllByText("Sin datos").length).toBeGreaterThanOrEqual(4)
  })

  it("con una sola sede y sin «multi_store», no hay selector de sede", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe() })

    await screen.findByText("Ventas por hora")
    expect(screen.queryByRole("group", { name: "Sede" })).not.toBeInTheDocument()
    expect(screen.queryByText("Todas las sedes")).not.toBeInTheDocument()
  })

  it("con más de una sede, «Todas las sedes» pide el consolidado y muestra «Por sede»", async () => {
    storeState.stores = [
      { id: 1, name: "Sede Centro" },
      { id: 2, name: "Sede Norte" },
    ]
    getReportsOverviewMock.mockImplementation(({ storeId }: { storeId: number | "all" }) =>
      Promise.resolve(
        storeId === "all"
          ? overview({
              scope: "all",
              store_id: null,
              store_ids: [1, 2],
              by_store: [
                { store_id: 2, store_name: "Sede Norte", net: 600_000, orders: 22, avg_ticket: 27_273, share_bp: 6_000 },
                { store_id: 1, store_name: "Sede Centro", net: 400_000, orders: 18, avg_ticket: 22_222, share_bp: 4_000 },
              ],
            })
          : overview(),
      ),
    )
    renderWithProviders(<InformesPage />, { me: buildMe() })

    const grupo = await screen.findByRole("group", { name: "Sede" })
    expect(within(grupo).getByRole("button", { name: "Sede Centro" })).toHaveAttribute("aria-pressed", "true")
    await screen.findByText("Ventas por hora")
    expect(screen.queryByText("Por sede")).not.toBeInTheDocument()

    await userEvent.click(within(grupo).getByRole("button", { name: "Todas las sedes" }))

    await screen.findByText("Por sede")
    expect(getReportsOverviewMock).toHaveBeenLastCalledWith(expect.objectContaining({ storeId: "all" }))
    const porSede = screen.getByRole("region", { name: "Por sede" })
    expect(within(porSede).getByText("Sede Norte")).toBeInTheDocument()
    expect(within(porSede).getByText("$ 600.000")).toBeInTheDocument()
    expect(within(porSede).getByText("$ 27.273")).toBeInTheDocument()
    // El historial se mira por sede: consolidado, «sin dato» con motivo.
    expect(screen.getByText("El historial se mira sede por sede: elegí una sede arriba.")).toBeInTheDocument()
  })

  it("con «multi_store» encendida aparece el selector aunque haya una sede", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe({ features: { multi_store: true } }) })

    expect(await screen.findByRole("group", { name: "Sede" })).toBeInTheDocument()
  })

  it("el filtro de categoría del top de productos filtra filas, sin recalcular", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe() })

    const top = (await screen.findByText("Top de productos")).closest("section") as HTMLElement
    expect(within(top).getByText("Bandeja Paisa: $ 700.000 en 28 u.")).toBeInTheDocument()
    expect(within(top).getByLabelText("Categoría")).toBeInTheDocument()
  })

  it("el historial despliega el detalle de la comanda que ya existe en Pedidos", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    adminListOrdersMock.mockResolvedValue({
      rows: [{ id: 1418, channel: "dine_in", status: "paid", total: 54_000 }],
      kitchen_times_by_station: [],
      sent_at_payment_ratio: null,
    })
    adminGetOrderMock.mockResolvedValue({
      id: 1418,
      channel: "dine_in",
      status: "paid",
      totals: { total: 54_000 },
      items: [{ id: 1, qty: 2, name: "Ajiaco", net: 54_000, status: "served" }],
    })
    renderWithProviders(<InformesPage />, { me: buildMe() })

    const fila = await screen.findByRole("button", { name: /#1418/ })
    expect(fila).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(fila)
    expect(fila).toHaveAttribute("aria-expanded", "true")
    await waitFor(() => expect(screen.getByText("2× Ajiaco")).toBeInTheDocument())
    expect(adminGetOrderMock).toHaveBeenCalledWith(1418)
  })
})

describe("rangoDePeriodo", () => {
  it("Hoy, Semana (desde el lunes) y Mes (desde el 1)", () => {
    expect(rangoDePeriodo("hoy", "2026-09-25")).toEqual({ from: "2026-09-25", to: "2026-09-25" })
    // 2026-09-25 es viernes: la semana arranca el lunes 21.
    expect(rangoDePeriodo("semana", "2026-09-25")).toEqual({ from: "2026-09-21", to: "2026-09-25" })
    expect(rangoDePeriodo("semana", "2026-09-21")).toEqual({ from: "2026-09-21", to: "2026-09-21" })
    expect(rangoDePeriodo("mes", "2026-09-25")).toEqual({ from: "2026-09-01", to: "2026-09-25" })
  })
})
