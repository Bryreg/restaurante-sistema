import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ShiftRecordOut, StorePanelOut } from "@/api/panel"
import { buildMe, renderWithProviders } from "@/test/utils"

import { OperationalTab } from "@/features/shifts/admin/OperationalTab"

import { FichaTurno } from "../fichas/FichaTurno"
import { PanelAhora } from "../PanelAhora"
import { TodayPage } from "../TodayPage"

const { storeState, getPanelMock, getTodayMock, getShiftRecordMock, getShiftSummaryMock, listAdminShiftsMock } =
  vi.hoisted(() => ({
    storeState: {
      stores: [{ id: 1, name: "Sede Centro" }] as { id: number; name: string }[],
      setActiveStoreId: vi.fn(),
    },
    getPanelMock: vi.fn(),
    getTodayMock: vi.fn(),
    getShiftRecordMock: vi.fn(),
    getShiftSummaryMock: vi.fn(),
    listAdminShiftsMock: vi.fn(),
  }))

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: storeState.stores,
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: storeState.setActiveStoreId,
  }),
}))

vi.mock("@/api/panel", async () => {
  const actual = await vi.importActual<typeof import("@/api/panel")>("@/api/panel")
  return { ...actual, getPanel: getPanelMock, getShiftRecord: getShiftRecordMock }
})

vi.mock("@/api/reports", async () => {
  const actual = await vi.importActual<typeof import("@/api/reports")>("@/api/reports")
  return { ...actual, getToday: getTodayMock }
})

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts")
  return { ...actual, getShiftSummary: getShiftSummaryMock, listAdminShifts: listAdminShiftsMock }
})

const STALE_CASH = {
  shift_id: 7,
  business_date: "2026-09-16",
  opened_at: "2026-09-16T14:00:00Z",
  responsible: { id: 3, name: "Operador 1", active: false },
  is_stale: true,
  stale_since: "2026-09-17T11:00:00Z",
  cash_over_threshold: false,
  expected_cash: 480_000,
}

function storePanel(overrides: Partial<StorePanelOut> = {}): StorePanelOut {
  return {
    store_id: 1,
    store_name: "Sede Centro",
    business_date: "2026-09-26",
    light: "red",
    reasons: [
      { key: "shift_stale", level: "critical", text: "Turno abandonado: sigue abierto desde el 2026-09-16." },
      { key: "responsible_inactive", level: "warning", text: "La caja está a nombre de Operador 1, que ya no está activo." },
    ],
    cash: STALE_CASH,
    closed: false,
    staff: {
      present: [],
      pending_review: [
        { entry_id: 1, employee_id: 3, name: "Operador 1", business_date: "2026-09-16", in_at: "2026-09-16T14:00:00Z" },
      ],
      reason: "Nadie marcó entrada hoy.",
    },
    area_counts: {
      enabled: true,
      areas_total: 2,
      opening_done: 1,
      opening_missing: 1,
      closing_done: 0,
      flagged: 1,
      pending_recounts: 0,
    },
    salon: { tables_occupied: 2, tables_total: 8, open_orders: 3, unsent: 1, unpaid: 0 },
    kitchen: { enabled: true, in_kitchen: 4, late: 2, very_late: 1, oldest_late_minutes: 31 },
    pending: {
      deposits_to_confirm: 0,
      requests_pending: 0,
      novelties_open: 0,
      novelties_urgent: 0,
      unreviewed_closes: 0,
      reserve_loans_open: 1,
      reserve_loans_total: 50_000,
      attendance_review: 1,
    },
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.stores = [{ id: 1, name: "Sede Centro" }]
})

describe("PanelAhora (la portada)", () => {
  it("un turno abandonado de otro día se ve abandonado, con su responsable inactivo y su ficha", async () => {
    getPanelMock.mockResolvedValue({ scope: "store", generated_at: "2026-09-26T15:00:00Z", stores: [storePanel()] })

    renderWithProviders(<PanelAhora />, { me: buildMe() })

    expect(await screen.findByText(/Turno abandonado del/)).toBeInTheDocument()
    expect(getPanelMock).toHaveBeenCalledWith(1)
    expect(screen.getByText("inactivo")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Turno #7/ })).toHaveAttribute("href", "/admin/dinero/turno/7")
    expect(screen.getByRole("link", { name: "Operador 1" })).toHaveAttribute("href", "/admin/personal/persona/3")
    // Quién trabaja: la asistencia real; la entrada del 16 es una salida olvidada.
    expect(screen.getByText(/Nadie marcó entrada hoy/)).toBeInTheDocument()
    expect(screen.getByText(/1 salida olvidada a revisar: Operador 1/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Nómina › Horas/ })).toHaveAttribute("href", "/admin/nomina?tab=horas")
    expect(screen.getByText(/1 préstamo de la base sin devolver/)).toBeInTheDocument()
    expect(screen.getByText(/1 área sin apertura/)).toBeInTheDocument()
    expect(screen.getByText(/2 platos atrasados/)).toBeInTheDocument()
    expect(screen.getByText("Requiere atención")).toBeInTheDocument()
  })

  it("quién trabaja sale de la asistencia; sin turno ni actividad la sede está cerrada, no en rojo", async () => {
    getPanelMock.mockResolvedValue({
      scope: "store",
      generated_at: "2026-09-26T15:00:00Z",
      stores: [
        storePanel({
          light: "gray",
          reasons: [],
          closed: true,
          cash: null,
          staff: {
            present: [
              { employee_id: 8, name: "Cocinero Juan", since: "2026-09-26T11:00:00Z", on_pause: false, active: true, puesto: "cocina" },
            ],
            pending_review: [],
            reason: null,
          },
          pending: {
            deposits_to_confirm: 0,
            requests_pending: 0,
            novelties_open: 0,
            novelties_urgent: 0,
            unreviewed_closes: 0,
            reserve_loans_open: 0,
            reserve_loans_total: null,
            attendance_review: 0,
          },
        }),
      ],
    })

    renderWithProviders(<PanelAhora />, { me: buildMe() })

    expect(await screen.findByText("1 persona con entrada")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Cocinero Juan" })).toHaveAttribute("href", "/admin/personal/persona/8")
    expect(screen.getAllByText("Cerrado").length).toBeGreaterThan(0)
    expect(screen.getByText(/la sede no está operando/)).toBeInTheDocument()
  })

  it("con varias sedes pide todas y las pone en un semáforo que cambia la sede activa", async () => {
    storeState.stores = [
      { id: 1, name: "Sede Centro" },
      { id: 2, name: "Sede Norte" },
    ]
    getPanelMock.mockResolvedValue({
      scope: "all",
      generated_at: "2026-09-26T15:00:00Z",
      stores: [storePanel(), storePanel({ store_id: 2, store_name: "Sede Norte", light: "green", reasons: [] })],
    })

    renderWithProviders(<PanelAhora />, { me: buildMe() })

    const semaforo = await screen.findByRole("list", { name: "Todas las sedes ahora" })
    expect(getPanelMock).toHaveBeenCalledWith("all")
    expect(within(semaforo).getByText(/Al día/)).toBeInTheDocument()
    await userEvent.click(within(semaforo).getByRole("button", { name: /Sede Norte/ }))
    expect(storeState.setActiveStoreId).toHaveBeenCalledWith(2)
  })
})

describe("Hoy y el turno abierto de otro día", () => {
  it("el turno abandonado es un aviso crítico que lleva a su ficha, y la tarjeta del esperado lo dice", async () => {
    getPanelMock.mockResolvedValue({ scope: "store", generated_at: "2026-09-26T15:00:00Z", stores: [storePanel()] })
    getTodayMock.mockResolvedValue({
      store_id: 1,
      business_date: "2026-09-26",
      sales_by_hour: [],
      gross: 0,
      net: 0,
      tax: 0,
      tips_total: 0,
      tips_by_method: [],
      orders: 0,
      covers: null,
      avg_ticket: null,
      avg_per_cover: null,
      tables_occupied: 0,
      tables_total: 0,
      open_orders: [],
      unsent_count: 0,
      unpaid_count: 0,
      expected_cash: 480_000,
      unavailable_products: [],
      pending_refunds_count: 0,
      unreviewed_closes_count: 0,
      alerts: [
        {
          type: "shift_stale",
          level: "warning",
          title: "Turno sin cerrar",
          body: "El turno #7 sigue abierto después de la hora de corte del día siguiente.",
          created_at: "2026-09-26T15:00:00Z",
          payload: { shift_id: 7 },
        },
      ],
      ingredients_below_min: [],
      ingredients_negative: [],
      preps_without_production: [],
      products_discounting_nothing: [],
      current_shift: STALE_CASH,
      store_closed: false,
      reserve_loans_open_count: 1,
      reserve_loans_open_total: 50_000,
      attendance_pending_review_count: 2,
    })

    renderWithProviders(<TodayPage />, { me: buildMe() })

    await waitFor(() => expect(screen.getAllByText(/Turno abandonado del/).length).toBeGreaterThan(0))
    const aviso = screen
      .getAllByText(/Turno abandonado del/)
      .map((el) => el.closest("li"))
      .find((li) => li !== null) as HTMLElement
    expect(within(aviso).getByRole("link")).toHaveAttribute("href", "/admin/dinero/turno/7")
    expect(within(aviso).getByText(/ya no está activo/)).toBeInTheDocument()
    expect(screen.getByText("1 préstamo de la base sin devolver")).toBeInTheDocument()
    const salidas = screen.getByText("2 salidas olvidadas a revisar").closest("li") as HTMLElement
    expect(within(salidas).getByRole("link")).toHaveAttribute("href", "/admin/nomina?tab=horas")
    // La notificación del servidor no se repite al lado del aviso directo.
    expect(screen.queryByText("Turno sin cerrar")).not.toBeInTheDocument()
  })
})

describe("Dinero › Operacional", () => {
  it("pide también los turnos abiertos de otros días y marca abandonado e inactivo", async () => {
    listAdminShiftsMock.mockResolvedValue([
      {
        id: 7,
        business_date: "2026-09-16",
        store_id: 1,
        status: "open",
        opened_at: "2026-09-16T14:00:00Z",
        cash_responsible: { id: 3, name: "Operador 1" },
        cash_responsible_active: false,
        expected_cash: 480_000,
        counted_cash: null,
        difference: null,
        is_stale: true,
      },
    ])

    renderWithProviders(<OperationalTab storeId={1} />, { me: buildMe() })

    expect(await screen.findByText(/Abandonado · /)).toBeInTheDocument()
    expect(listAdminShiftsMock).toHaveBeenCalledWith(expect.objectContaining({ storeId: 1, includeOpen: true }))
    expect(screen.getByText("inactivo")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Operador 1" })).toHaveAttribute("href", "/admin/personal/persona/3")
    expect(screen.getByRole("link", { name: "Ficha" })).toHaveAttribute("href", "/admin/dinero/turno/7")
  })
})

describe("Ficha del turno", () => {
  it("junta plata, ventas, anulaciones, conteos y asistencia, con cada cosa enlazada", async () => {
    const record: ShiftRecordOut = {
      shift_id: 7,
      store_id: 1,
      store_name: "Sede Centro",
      business_date: "2026-09-16",
      status: "open",
      opened_at: "2026-09-16T14:00:00Z",
      closed_at: null,
      is_stale: true,
      responsible: { id: 3, name: "Operador 1", active: false },
      opened_by: { id: 3, name: "Operador 1", active: false },
      closed_by: null,
      reviewed: false,
      sales: { key: "7", label: "Turno #7", net: 370_370, orders: 12 },
      deposit: null,
      opening_mode: "envelopes",
      opening_count: {
        envelopes: [{ source_shift_id: 5, business_date: "2026-09-15", expected: 300_000, counted: 290_000, difference: -10_000 }],
        expected_total: 300_000,
        counted_total: 290_000,
        counted_by: "Operador 1",
        counted_at: "2026-09-16T13:55:00Z",
      },
      reserve_movements: [
        { kind: "take", amount: 50_000, employee_name: "Operador 1", authorized_by: "Supervisor", at: "2026-09-16T16:00:00Z", reversed: false },
      ],
      reserve_loan_outstanding: 50_000,
      voids: [
        {
          order_id: 41,
          item_name: "Bandeja paisa",
          qty: 1,
          amount: 25_000,
          reason: "kitchen_error",
          voided_at: "2026-09-16T18:00:00Z",
          voided_by: "Operador 1",
          authorized_by: "Supervisor",
          after_bill: false,
        },
      ],
      discounts: [],
      novelties: [],
      area_counts: [
        { count_id: 5, area_name: "Barra", moment: "opening", counted_at: "2026-09-16T14:10:00Z", employee_name: "Operador 1" },
      ],
      attendance: [
        { shift_id: 7, business_date: "2026-09-16", employee_id: 3, employee_name: "Operador 1", in_at: "2026-09-16T14:00:00Z", out_at: null, status: "open" },
        { shift_id: 7, business_date: "2026-09-16", employee_id: 9, employee_name: "Supervisor", in_at: "2026-09-16T15:00:00Z", out_at: null, status: "closed" },
      ],
    }
    getShiftRecordMock.mockResolvedValue(record)
    getShiftSummaryMock.mockResolvedValue({
      id: 7,
      business_date: "2026-09-16",
      status: "open",
      opened_at: "2026-09-16T14:00:00Z",
      cash_responsible: { id: 3, name: "Operador 1" },
      opening_cash_total: 200_000,
      expected_cash: 480_000,
      pickups: [],
      movements: [],
      handovers: [],
      counted_cash: null,
      difference: null,
    })

    renderWithProviders(
      <Routes>
        <Route path="/admin/dinero/turno/:shiftId" element={<FichaTurno />} />
      </Routes>,
      { me: buildMe(), route: "/admin/dinero/turno/7" },
    )

    expect(await screen.findByRole("heading", { name: "Turno #7" })).toBeInTheDocument()
    expect(getShiftRecordMock).toHaveBeenCalledWith(7)
    expect(screen.getByText(/nadie lo cerró/)).toBeInTheDocument()
    expect(screen.getByText("$ 370.370")).toBeInTheDocument()
    expect(screen.getByText("$ 480.000")).toBeInTheDocument()
    expect(screen.getByText("1 × Bandeja paisa")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Barra" })).toHaveAttribute("href", "/admin/inventario?tab=por-area&conteo=5")
    expect(screen.getAllByText("Salió").length).toBeGreaterThan(1)
    // Apertura por sobres: cada sobre enlaza al turno de donde salió.
    expect(screen.getByRole("link", { name: /turno #5/ })).toHaveAttribute("href", "/admin/dinero/turno/5")
    expect(screen.getByText("Tomó de la base")).toBeInTheDocument()
    expect(screen.getByText(/el cajón le debe \$ 50\.000 a la base/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Rescates y revisión" })).toBeInTheDocument()
  })
})

describe("Hoy sin turno abierto", () => {
  it("con la sede cerrada el aviso es neutro; con actividad, crítico", async () => {
    const base = {
      store_id: 1,
      business_date: "2026-09-26",
      sales_by_hour: [],
      gross: 0,
      net: 0,
      tax: 0,
      tips_total: 0,
      tips_by_method: [],
      orders: 0,
      covers: null,
      avg_ticket: null,
      avg_per_cover: null,
      tables_occupied: 0,
      tables_total: 0,
      open_orders: [],
      unsent_count: 0,
      unpaid_count: 0,
      expected_cash: null,
      unavailable_products: [],
      pending_refunds_count: 0,
      unreviewed_closes_count: 0,
      alerts: [],
      ingredients_below_min: [],
      ingredients_negative: [],
      preps_without_production: [],
      products_discounting_nothing: [],
      current_shift: null,
    }
    getPanelMock.mockResolvedValue({ scope: "store", generated_at: "2026-09-26T03:00:00Z", stores: [] })
    getTodayMock.mockResolvedValue({ ...base, store_closed: true })
    const { unmount } = renderWithProviders(<TodayPage />, { me: buildMe() })
    expect(await screen.findByText(/la sede está cerrada: no hay turno de caja/)).toBeInTheDocument()
    expect(screen.queryByText(/Hay actividad sin turno de caja/)).not.toBeInTheDocument()
    unmount()

    getTodayMock.mockResolvedValue({ ...base, store_closed: false })
    renderWithProviders(<TodayPage />, { me: buildMe() })
    expect(await screen.findByText(/Hay actividad sin turno de caja/)).toBeInTheDocument()
  })
})
