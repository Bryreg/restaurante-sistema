import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  OverviewSeriesOut,
  ReportsOverviewOut,
  SalesBucketOut,
  SeriesPointOut,
  StoresWeekSeriesOut,
} from "@/api/reports"
import { buildMe, renderWithProviders } from "@/test/utils"

import { InformesPage } from "../InformesPage"
import { rangoDePeriodo, todayInBogota } from "../lib"

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


function punto(over: Pick<SeriesPointOut, "key" | "label" | "value"> & Partial<SeriesPointOut>): SeriesPointOut {
  return { reference: null, delta_bp: null, outside: false, future: false, now: false, ...over }
}

/** Las series «barra + raya» como las publica `app/reports/series.py`: dato, raya y lado ya decididos. */
function series(over: Partial<OverviewSeriesOut> = {}): OverviewSeriesOut {
  return {
    daily_sales: {
      available: true,
      reason: null,
      unit: "cop",
      bad_side: "below",
      reference: null,
      points: [
        punto({ key: "2026-09-21", label: "lun 21", value: 400_000, reference: 500_000, delta_bp: -2_000, outside: true }),
        punto({ key: "2026-09-22", label: "mar 22", value: 600_000, reference: 500_000, delta_bp: 2_000 }),
      ],
      days_with_reference: 2,
      days_above: 1,
      best_key: "2026-09-22",
    },
    category_margin: {
      available: true,
      reason: null,
      unit: "bp",
      bad_side: "below",
      reference: 6_500,
      total_bp: 6_420,
      points: [
        {
          ...punto({ key: "20", label: "Bebidas", value: 7_900, reference: 6_500 }),
          net: 300_000,
          gross_margin: 237_000,
          costed_pct: 100,
          previous_bp: 7_800,
          delta_points_bp: 100,
          gap_bp: null,
        },
        {
          ...punto({ key: "10", label: "Platos", value: 5_700, reference: 6_500, outside: true }),
          net: 700_000,
          gross_margin: 399_000,
          costed_pct: 100,
          previous_bp: 6_000,
          delta_points_bp: -300,
          gap_bp: 800,
        },
      ],
    },
    stores_week: null,
    peak_hours: {
      available: true,
      reason: null,
      unit: "count",
      bad_side: "above",
      orders_per_waiter: 7,
      views: [
        {
          key: "avg",
          label: "Promedio",
          days: 5,
          points: [
            { ...punto({ key: "12", label: "12 p. m.", value: 15, reference: 14, outside: true }), waiters: 2 },
            { ...punto({ key: "13", label: "1 p. m.", value: 10, reference: 14 }), waiters: 2 },
            { ...punto({ key: "14", label: "2 p. m.", value: 4, reference: 7 }), waiters: 1 },
          ],
        },
        {
          key: "sat",
          label: "sáb",
          days: 1,
          points: [
            { ...punto({ key: "12", label: "12 p. m.", value: 6, reference: 14 }), waiters: 2 },
            { ...punto({ key: "13", label: "1 p. m.", value: 5, reference: 14 }), waiters: 2 },
          ],
        },
      ],
    },
    dish_mix: {
      available: true,
      reason: null,
      avg_units: 44,
      avg_margin_bp: 6_950,
      points: [
        { key: "2", label: "Limonada", units: 60, margin_bp: 8_100, net: 300_000, group: "keep" },
        { key: "1", label: "Bandeja Paisa", units: 28, margin_bp: 5_800, net: 700_000, group: "review" },
      ],
      without_cost: 1,
    },
    ...over,
  }
}

const STORES_WEEK: StoresWeekSeriesOut = {
  available: true,
  reason: null,
  unit: "cop",
  bad_side: "below",
  points: [
    { ...punto({ key: "2", label: "Sede Norte", value: 600_000, reference: 500_000, delta_bp: 2_000 }), store_id: 2, avg_ticket: 27_273, margin_bp: 6_400 },
    {
      ...punto({ key: "1", label: "Sede Centro", value: 400_000, reference: 450_000, delta_bp: -1_111, outside: true }),
      store_id: 1,
      avg_ticket: 22_222,
      margin_bp: null,
    },
  ],
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
    series: series(),
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
  it("las cinco preguntas primero y lo de antes plegado al pie, con las cifras del servidor tal cual", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe() })

    await screen.findByText("Ventas netas · Sede Centro")
    // Cambio intencional (handoff del panel, pantalla 11): arriba van las
    // preguntas «barra + raya»; las secciones de antes no se borraron, se
    // movieron a «Más del período», plegado.
    expect(titulosDeSeccion()).toEqual([
      "Ventas",
      "Margen",
      "Mix de platos",
      "Horas pico",
      "Método de pago",
      "Ventas por hora",
      "Top de productos",
      "Por persona",
      "Canal y zona",
      "Domicilios y clientes",
      "Ingeniería de menú",
      "Historial de comandas",
    ])
    expect(screen.getByText(/Más del período/).closest("details")).not.toHaveAttribute("open")

    // La banda de cifra: cobrado − impuesto = neto, la propina debajo de la raya y la comparación del servidor.
    expect(screen.getByText("Cobrado en caja y medios").nextSibling).toHaveTextContent("$ 1.080.000")
    expect(screen.getByText("Propinas · pasan a los meseros, no son venta").nextSibling).toHaveTextContent("$ 45.000")
    expect(screen.getByText("▲ +25,0 %")).toBeInTheDocument()
    expect(screen.getByText("40 comandas · ticket promedio $ 25.000")).toBeInTheDocument()

    // Ventas por día: el lado malo lo decide el servidor; la cifra lleva flecha y signo.
    const dias = screen.getByRole("region", { name: "¿Vendí más o menos que la semana pasada?" })
    expect(within(dias).getByText("▼ −20 %")).toBeInTheDocument()
    expect(within(dias).getByText("▲ +20 %")).toBeInTheDocument()
    expect(within(dias).getByText("1 de 2 días por encima")).toBeInTheDocument()
    expect(within(dias).getByText("lun 21 quedó abajo")).toBeInTheDocument()
    expect(within(dias).getByText("El mejor: mar 22")).toBeInTheDocument()

    // Margen por categoría contra la meta de Ajustes.
    const margen = screen.getByRole("region", { name: "¿Qué categoría deja menos plata?" })
    expect(within(margen).getByText(/^Meta: 65\s%$/)).toBeInTheDocument()
    expect(within(margen).getByText("8 pts bajo la meta")).toBeInTheDocument()
    expect(within(margen).getByText("▲ +1 pts")).toBeInTheDocument()
    expect(within(margen).getByText(/^Platos: 57\s%$/)).toBeInTheDocument()

    // Mix de platos: el grupo lo manda el servidor.
    const mix = screen.getByRole("region", { name: "¿Qué platos venden y dejan plata?" })
    expect(within(mix).getByText("Limonada. Cuidarlos: que nunca falten.")).toBeInTheDocument()
    expect(within(mix).getByText("Bandeja Paisa. Venden poco y dejan poco.")).toBeInTheDocument()
    expect(within(mix).getByText(/1 plato vendido no tiene costo/)).toBeInTheDocument()

    // Horas pico: franja pasada y la fila de meseros.
    const pico = screen.getByRole("region", { name: "Comandas de salón por hora, promedio del período" })
    expect(within(pico).getByText("De 12 p. m. a 1 p. m.")).toBeInTheDocument()
    expect(within(pico).getByText("Promedio de 5 días operados")).toBeInTheDocument()
    expect(within(pico).getAllByText("meseros")).toHaveLength(3)

    // Lo de antes sigue ahí, intacto.
    const indicadores = screen.getByRole("region", { name: "Indicadores" })
    expect(within(indicadores).getAllByText(/▲ 25,0 % vs 16 al 20 sep/).length).toBeGreaterThan(0)
    expect(screen.getByText("Hora pico: 13:00 con $ 766.900 en 32 comandas")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Ver la matriz completa/ })).toHaveAttribute("href", "/admin/analitica")
    expect(screen.getByText("Costo y margen").closest("details")).not.toHaveAttribute("open")
    expect(getReportsOverviewMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1 }))
  })

  it("el período de entrada son los últimos 7 días cerrados, sin hoy", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe() })

    await screen.findByText("Ventas netas · Sede Centro")
    const { from, to } = rangoDePeriodo("ultimos7", todayInBogota())
    expect(getReportsOverviewMock).toHaveBeenCalledWith({ storeId: 1, from, to })
    expect(screen.getByText("Hoy no entra: el día sigue abierto")).toBeInTheDocument()
    expect(screen.getByRole("combobox", { name: "Período" })).toHaveTextContent("Últimos 7 días")
  })

  it("el día de la semana de Horas pico cambia la vista sin pedir nada al servidor", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe() })

    const grupo = await screen.findByRole("group", { name: "Día de la semana" })
    const llamadas = getReportsOverviewMock.mock.calls.length
    await userEvent.click(within(grupo).getByRole("button", { name: "sáb" }))
    expect(within(grupo).getByRole("button", { name: "sáb" })).toHaveAttribute("aria-pressed", "true")
    const pico = screen.getByRole("region", { name: "Comandas de salón por hora, los sábados" })
    expect(within(pico).getByText("Los sábados")).toBeInTheDocument()
    expect(within(pico).getByText("El salón alcanza todas las horas")).toBeInTheDocument()
    expect(getReportsOverviewMock.mock.calls.length).toBe(llamadas)
  })

  it("margen y mix hablan de costo: sin sesión de administrador no se dibujan", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe({ kind: "device" }) })

    await screen.findByText("Ventas netas · Sede Centro")
    expect(screen.queryByRole("region", { name: "¿Qué categoría deja menos plata?" })).not.toBeInTheDocument()
    expect(screen.queryByRole("region", { name: "¿Qué platos venden y dejan plata?" })).not.toBeInTheDocument()
  })

  it("sin series (backend viejo) o sin datos, cada pregunta dice por qué y nunca dibuja un 0", async () => {
    getReportsOverviewMock.mockResolvedValue(
      overview({
        series: series({
          dish_mix: {
            available: false,
            reason: "Ningún plato vendido en el período tiene costo: sin costo no hay margen que ubicar.",
            avg_units: null,
            avg_margin_bp: null,
            points: [],
            without_cost: 3,
          },
          peak_hours: {
            available: false,
            reason: "No hay días operados en el período: no hay comandas por hora que mostrar.",
            unit: "count",
            bad_side: "above",
            orders_per_waiter: 7,
            views: [],
          },
        }),
      }),
    )
    renderWithProviders(<InformesPage />, { me: buildMe() })

    expect(
      await screen.findByText("Ningún plato vendido en el período tiene costo: sin costo no hay margen que ubicar."),
    ).toBeInTheDocument()
    expect(screen.getByText("No hay días operados en el período: no hay comandas por hora que mostrar.")).toBeInTheDocument()
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
    expect(screen.queryByRole("region", { name: "¿Qué sede va mejor?" })).not.toBeInTheDocument()
    expect(screen.queryByText("Todas las sedes")).not.toBeInTheDocument()
  })

  it("con más de una sede entra con «Todas las sedes», y elegir una recalcula todo junto sin perder «Por sede»", async () => {
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
              series: series({ stores_week: STORES_WEEK }),
            })
          : overview(),
      ),
    )
    renderWithProviders(<InformesPage />, { me: buildMe() })

    // Cambio intencional (handoff, pantalla 11): el selector es segmentado
    // con todas las sedes, y se entra por «Todas las sedes».
    const grupo = await screen.findByRole("group", { name: "Sede" })
    expect(within(grupo).getByRole("button", { name: "Todas las sedes" })).toHaveAttribute("aria-pressed", "true")
    expect(await screen.findByText("Ventas netas · todas las sedes")).toBeInTheDocument()
    expect(getReportsOverviewMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: "all" }))

    const porSede = screen.getByRole("region", { name: "¿Qué sede va mejor?" })
    expect(within(porSede).getByText("$ 600.000")).toBeInTheDocument()
    expect(within(porSede).getByText("▲ +20,0 %")).toBeInTheDocument()
    // Del lado malo la flecha va en la cifra y el detalle lleva sólo el signo.
    expect(within(porSede).getByText("▼ $ 400.000")).toBeInTheDocument()
    expect(within(porSede).getByText("−11,1 %")).toBeInTheDocument()
    expect(within(porSede).getByText(/^Ticket \$ 27\.273 · margen 64,0\s%$/)).toBeInTheDocument()
    expect(within(porSede).getByText("Ticket $ 22.222 · margen sin dato")).toBeInTheDocument()
    // El historial se mira por sede: consolidado, «sin dato» con motivo.
    expect(screen.getByText("El historial se mira sede por sede: elegí una sede arriba.")).toBeInTheDocument()

    await userEvent.click(within(grupo).getByRole("button", { name: "Sede Norte" }))
    expect(await screen.findByText("Ventas netas · Sede Norte")).toBeInTheDocument()
    expect(getReportsOverviewMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 2 }))
    // «Por sede» sigue: es la misma consulta consolidada, de la caché.
    expect(screen.getByRole("region", { name: "¿Qué sede va mejor?" })).toBeInTheDocument()
  })

  it("con «multi_store» encendida aparece el selector aunque haya una sede", async () => {
    getReportsOverviewMock.mockResolvedValue(overview())
    renderWithProviders(<InformesPage />, { me: buildMe({ features: { multi_store: true } }) })

    const grupo = await screen.findByRole("group", { name: "Sede" })
    // Con una sola sede se entra por esa sede, no por el consolidado.
    expect(within(grupo).getByRole("button", { name: "Sede Centro" })).toHaveAttribute("aria-pressed", "true")
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
  it("Últimos 7 días cerrados (sin hoy), Hoy, Semana (desde el lunes) y Mes (desde el 1)", () => {
    expect(rangoDePeriodo("ultimos7", "2026-09-27")).toEqual({ from: "2026-09-20", to: "2026-09-26" })
    expect(rangoDePeriodo("ultimos7", "2026-10-02")).toEqual({ from: "2026-09-25", to: "2026-10-01" })
    expect(rangoDePeriodo("hoy", "2026-09-25")).toEqual({ from: "2026-09-25", to: "2026-09-25" })
    // 2026-09-25 es viernes: la semana arranca el lunes 21.
    expect(rangoDePeriodo("semana", "2026-09-25")).toEqual({ from: "2026-09-21", to: "2026-09-25" })
    expect(rangoDePeriodo("semana", "2026-09-21")).toEqual({ from: "2026-09-21", to: "2026-09-21" })
    expect(rangoDePeriodo("mes", "2026-09-25")).toEqual({ from: "2026-09-01", to: "2026-09-25" })
  })
})
