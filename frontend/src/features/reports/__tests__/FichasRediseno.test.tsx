/**
 * Las fichas relacionales con el lenguaje «barra + raya» (handoff del panel,
 * pantallas 9 y 10): cada gráfico dibuja lo que manda el servidor —dato,
 * raya y de qué lado quedó— y las tablas viven detrás de «Ver…».
 */
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { EmployeeRecordOut, IngredientRecordOut, ShiftRecordOut } from "@/api/panel"
import { buildMe, renderWithProviders } from "@/test/utils"

import { FichaInsumo } from "../fichas/FichaInsumo"
import { FichaPersona } from "../fichas/FichaPersona"
import { FichaTurno } from "../fichas/FichaTurno"

const mocks = vi.hoisted(() => ({
  getShiftRecord: vi.fn(),
  getEmployeeRecord: vi.fn(),
  getIngredientRecord: vi.fn(),
  getShiftSummary: vi.fn(),
  getEmployeeActivity: vi.fn(),
  getIngredientMovements: vi.fn(),
}))

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({
    stores: [{ id: 1, name: "Sede Centro" }],
    loading: false,
    activeStoreId: 1,
    setActiveStoreId: vi.fn(),
  }),
}))

vi.mock("@/api/panel", async () => {
  const actual = await vi.importActual<typeof import("@/api/panel")>("@/api/panel")
  return {
    ...actual,
    getShiftRecord: mocks.getShiftRecord,
    getEmployeeRecord: mocks.getEmployeeRecord,
    getIngredientRecord: mocks.getIngredientRecord,
  }
})

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts")
  return { ...actual, getShiftSummary: mocks.getShiftSummary, getEmployeeActivity: mocks.getEmployeeActivity }
})

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, getIngredientMovements: mocks.getIngredientMovements }
})

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Ficha de turno
// ---------------------------------------------------------------------------

const TURNO: ShiftRecordOut = {
  shift_id: 12,
  store_id: 1,
  store_name: "Sede Centro",
  business_date: "2026-09-26",
  status: "closed",
  opened_at: "2026-09-26T12:01:00Z",
  closed_at: "2026-09-27T03:48:00Z",
  is_stale: false,
  responsible: { id: 4, name: "Diana Pérez", active: true },
  opened_by: { id: 3, name: "Kevin Ruiz", active: true },
  closed_by: "Diana Pérez",
  reviewed: false,
  sales: { key: "12", label: "Turno #12", gross: 7_464_960, net: 6_912_000, tax: 552_960, tips: 598_300, orders: 164 },
  deposit: null,
  opening_mode: "envelopes",
  opening_count: {
    envelopes: [{ source_shift_id: 9, business_date: "2026-09-24", expected: 980_000, counted: 980_000, difference: 0 }],
    expected_total: 980_000,
    counted_total: 980_000,
    difference_total: 0,
    counted_by: "Kevin Ruiz",
    counted_at: "2026-09-26T12:04:00Z",
  },
  reserve_movements: [],
  reserve_loan_outstanding: null,
  voids: [
    {
      order_id: 41,
      item_name: "Churrasco 300 g",
      qty: 1,
      amount: 42_000,
      reason: "kitchen_error",
      voided_at: "2026-09-26T18:18:00Z",
      voided_by: "Laura Gómez",
      authorized_by: "Diana Pérez",
      after_bill: false,
    },
  ],
  discounts: [
    {
      kind: "courtesy",
      order_id: 55,
      amount: 12_000,
      reason: null,
      employee_name: "Yuli Cárdenas",
      authorized_by: "Diana Pérez",
      at: "2026-09-27T01:40:00Z",
    },
  ],
  novelties: [],
  area_counts: [],
  attendance: [
    {
      shift_id: 12,
      business_date: "2026-09-26",
      employee_id: 3,
      employee_name: "Kevin Ruiz",
      in_at: "2026-09-26T12:00:00Z",
      out_at: "2026-09-26T20:10:00Z",
      status: "closed",
      worked_minutes: 490,
    },
    {
      shift_id: 12,
      business_date: "2026-09-26",
      employee_id: 4,
      employee_name: "Diana Pérez",
      in_at: "2026-09-26T19:55:00Z",
      out_at: "2026-09-27T04:05:00Z",
      status: "closed",
      worked_minutes: 490,
    },
  ],
  cash_by_hour: {
    available: true,
    reason: null,
    unit: "cop",
    bad_side: "above",
    reference: 1_200_000,
    hours_over: 2,
    truncated: false,
    points: [
      { key: "a", label: "7 a. m.", value: 300_000, reference: 1_200_000, delta_bp: null, outside: false, future: false, now: false, pickups: [] },
      { key: "b", label: "8 a. m.", value: 1_420_000, reference: 1_200_000, delta_bp: null, outside: true, future: false, now: false, pickups: [] },
      { key: "c", label: "9 a. m.", value: 780_000, reference: 1_200_000, delta_bp: null, outside: false, future: false, now: false, pickups: [800_000] },
      { key: "d", label: "10 a. m.", value: 3_080_000, reference: 1_200_000, delta_bp: null, outside: true, future: false, now: false, pickups: [] },
    ],
  },
}

function renderTurno(): void {
  mocks.getShiftRecord.mockResolvedValue(TURNO)
  mocks.getShiftSummary.mockResolvedValue({
    id: 12,
    business_date: "2026-09-26",
    status: "closed",
    opened_at: "2026-09-26T12:01:00Z",
    closed_at: "2026-09-27T03:48:00Z",
    cash_responsible: { id: 4, name: "Diana Pérez" },
    opening_cash_total: 980_000,
    expected_cash: 3_082_500,
    counted_cash: 3_078_500,
    difference: -4_000,
    pickups: [{ id: 1, amount: 800_000, at: "2026-09-26T14:40:00Z", authorized_by_employee_name: "Kevin Ruiz" }],
    movements: [],
    handovers: [
      {
        id: 5,
        kind: "handover",
        from_responsible: { id: 3, name: "Kevin Ruiz" },
        new_responsible: { id: 4, name: "Diana Pérez" },
        counted_cash: 1_034_000,
        breakdown: { expected: 1_034_000, counted: 1_034_000, difference: 0 },
        at: "2026-09-26T20:05:00Z",
      },
    ],
  })
  renderWithProviders(
    <Routes>
      <Route path="/admin/dinero/turno/:shiftId" element={<FichaTurno />} />
    </Routes>,
    { me: buildMe(), route: "/admin/dinero/turno/12" },
  )
}

describe("Ficha de turno", () => {
  it("la banda de cifra deriva la venta y deja la propina debajo de la raya", async () => {
    renderTurno()
    expect(await screen.findByRole("heading", { name: "Turno del sábado 26 sep" })).toBeInTheDocument()
    expect(screen.getByText("▼ Cerró con faltante de $ 4.000")).toBeInTheDocument()
    expect(screen.getByText("Cobrado en caja y medios").nextSibling).toHaveTextContent("$ 7.464.960")
    expect(screen.getByText("Impuesto discriminado").nextSibling).toHaveTextContent("−$ 552.960")
    expect(screen.getByText("Propinas · pasan a los meseros, no son venta").nextSibling).toHaveTextContent("$ 598.300")
    expect(screen.getByText("164 comandas pagadas")).toBeInTheDocument()
  })

  it("«¿Cuadró en cada paso?»: apertura → relevo → cierre, cada uno con esperado, contado y diferencia del servidor", async () => {
    renderTurno()
    await screen.findByText("¿Cuadró en cada paso?")
    const pasos = [...document.querySelectorAll<HTMLElement>("[data-paso]")]
    expect(pasos.map((p) => p.dataset.paso)).toEqual(["apertura", "h-5", "cierre"])
    const [apertura, relevo, cierre] = pasos.map((p) => within(p))
    expect(apertura!.getByText("Sobre del jue 24 sep")).toBeInTheDocument()
    expect(apertura!.getByText("= $ 0 cuadra")).toBeInTheDocument()
    expect(relevo!.getByText("Kevin Ruiz entrega a Diana Pérez")).toBeInTheDocument()
    expect(relevo!.getAllByText("$ 1.034.000")).toHaveLength(2)
    // El dueño ve el esperado del cierre, lo contado y la diferencia tal como llegó.
    expect(cierre!.getByText("$ 3.082.500")).toBeInTheDocument()
    expect(cierre!.getByText("$ 3.078.500")).toBeInTheDocument()
    expect(cierre!.getByText(/-\$ 4\.000 faltante/)).toBeInTheDocument()
    expect(pasos[2]!.className).toContain("border-t-destructive")
  })

  it("«Efectivo en caja»: el lado malo del umbral lo decide el servidor y los retiros van marcados", async () => {
    renderTurno()
    const grafico = await screen.findByRole("region", { name: "¿Cuándo hubo más efectivo del que debía?" })
    expect(grafico.querySelectorAll("[data-barra][data-fuera]")).toHaveLength(2)
    expect(within(grafico).getByText("↓ $ 800.000")).toBeInTheDocument()
    expect(within(grafico).getByText("Umbral de retiro $ 1.200.000")).toBeInTheDocument()
    expect(within(grafico).getByText("A las 8 a. m. pasó el umbral")).toBeInTheDocument()
    expect(within(grafico).getByText("Se retiró a las 9 a. m.: ↓ $ 800.000.")).toBeInTheDocument()
    expect(within(grafico).getByText("No se retiró: cerró con $ 3.080.000 en el cajón.")).toBeInTheDocument()
  })

  it("«Quién trabajó» dibuja una fila por persona con el relevo, y el detalle junta correcciones y asistencia", async () => {
    renderTurno()
    const gantt = await screen.findByText("Quién trabajó")
    const seccion = gantt.closest("section") as HTMLElement
    expect(seccion.querySelectorAll("[data-fila]")).toHaveLength(2)
    expect(seccion.querySelectorAll("[data-relevo]")).toHaveLength(2)
    expect(within(seccion).getAllByText("8 h 10 min").length).toBeGreaterThan(0)
    expect(within(seccion).getAllByText(/Relevo de caja .* · Kevin Ruiz entrega a Diana Pérez/).length).toBeGreaterThan(0)

    const boton = screen.getByRole("button", { name: /Ver el detalle del turno · 8 listas/ })
    expect(boton).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(boton)
    expect(boton).toHaveAttribute("aria-expanded", "true")
    const correcciones = screen.getByRole("region", { name: "Anulaciones, descuentos y cortesías" })
    expect(within(correcciones).getByText("1 × Churrasco 300 g")).toBeInTheDocument()
    expect(within(correcciones).getByText("Cortesía")).toBeInTheDocument()
    // Las tablas anchas ocupan las dos columnas de la grilla.
    expect(correcciones.className).toContain("lg:col-span-2")
    const asistencia = screen.getByRole("region", { name: "Asistencia" })
    expect(asistencia.className).toContain("lg:col-span-2")
    expect(within(asistencia).getAllByText("8 h 10 min")).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Ficha de persona
// ---------------------------------------------------------------------------

const PERSONA: EmployeeRecordOut = {
  employee: { id: 3, name: "Kevin Ruiz", active: true },
  role: "operator",
  store_id: 1,
  date_from: "2026-08-29",
  date_to: "2026-09-27",
  charged: null,
  shifts_as_responsible: [
    { shift_id: 12, business_date: "2026-09-26", status: "closed", is_stale: false, difference: -2_000, closed_without_count: false },
  ],
  attendance: [
    {
      shift_id: null,
      business_date: "2026-09-27",
      employee_id: 3,
      employee_name: "Kevin Ruiz",
      in_at: "2026-09-27T12:02:00Z",
      out_at: null,
      status: "open",
      worked_minutes: null,
    },
    {
      shift_id: null,
      business_date: "2026-09-26",
      employee_id: 3,
      employee_name: "Kevin Ruiz",
      in_at: "2026-09-26T12:00:00Z",
      out_at: "2026-09-26T20:10:00Z",
      status: "closed",
      worked_minutes: 490,
    },
    {
      shift_id: null,
      business_date: "2026-09-20",
      employee_id: 3,
      employee_name: "Kevin Ruiz",
      in_at: "2026-09-20T12:18:00Z",
      out_at: null,
      status: "review",
      worked_minutes: null,
    },
  ],
  voids: [],
  discounts: [],
}

describe("Ficha de persona", () => {
  it("avatar, cuatro tarjetas con tono y el horario en un solo lugar: Nómina › Horario de la semana", async () => {
    mocks.getEmployeeRecord.mockResolvedValue(PERSONA)
    mocks.getEmployeeActivity.mockResolvedValue({ difference_streak: 2, authorizations_given: [] })
    const { container } = renderWithProviders(
      <Routes>
        <Route path="/admin/personal/persona/:employeeId" element={<FichaPersona />} />
      </Routes>,
      { me: buildMe({ features: { payroll: true } }), route: "/admin/personal/persona/3" },
    )

    expect(await screen.findByRole("heading", { name: "Kevin Ruiz" })).toBeInTheDocument()
    expect(screen.getByText("KR")).toBeInTheDocument()
    expect(await screen.findByText("Racha de cierres con diferencia")).toBeInTheDocument()

    // Un solo gráfico de horario en Equipo: la ficha no dibuja otro, enlaza.
    const seccion = screen.getByText("¿Llega y sale a su hora?").closest("section") as HTMLElement
    expect(container.querySelector('[data-slot="horario-gantt"]')).toBeNull()
    expect(within(seccion).getByRole("link", { name: "Nómina › Horario de la semana" })).toHaveAttribute(
      "href",
      "/admin/nomina?tab=semana",
    )

    // Las tablas, detrás de «Ver…».
    expect(screen.queryByRole("region", { name: "Turnos con la caja" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /Ver turnos con la caja/ }))
    const turnos = screen.getByRole("region", { name: "Turnos con la caja" })
    expect(within(turnos).getByRole("link", { name: /#12/ })).toHaveAttribute("href", "/admin/dinero/turno/12")
  })
})

// ---------------------------------------------------------------------------
// Ficha de insumo
// ---------------------------------------------------------------------------

function diaStock(i: number, over: Partial<{ qty: string | null; outside: boolean; future: boolean; now: boolean }> = {}) {
  const d = String(i + 7).padStart(2, "0")
  return { key: `2026-09-${d}`, label: `x ${i + 7}`, business_date: `2026-09-${d}`, qty: "10", outside: false, future: false, now: false, ...over }
}

const INSUMO: IngredientRecordOut = {
  ingredient_id: 8,
  name: "Aguardiente Antioqueño 750 ml",
  base_unit: "unit",
  active: true,
  store_id: 1,
  date_from: "2026-09-21",
  date_to: "2026-09-27",
  stock: "14.3",
  by_cause: [
    { cause: "purchase", movements: 2, qty: "24" },
    { cause: "sale", movements: 40, qty: "-12.6" },
  ],
  area_counts: [],
  stock_by_day: {
    available: true,
    reason: null,
    bad_side: "below",
    base_unit: "unit",
    min_stock: "6",
    daily_use: "0.7",
    below_min_on: "2026-10-09",
    runs_out_on: null,
    points: [
      diaStock(0, { qty: null }),
      diaStock(1, { qty: "5", outside: true }),
      diaStock(2, { qty: "14.3" }),
      diaStock(3, { qty: "13.6", future: true, now: true }),
      diaStock(4, { qty: "12.9", future: true }),
    ],
  },
}

describe("Ficha de insumo", () => {
  it("«¿Cuándo se me acaba?» dibuja la serie del servidor contra el mínimo, y las causas divergen", async () => {
    mocks.getIngredientRecord.mockResolvedValue(INSUMO)
    mocks.getIngredientMovements.mockResolvedValue([])
    renderWithProviders(
      <Routes>
        <Route path="/admin/inventario/insumo/:ingredientId" element={<FichaInsumo />} />
      </Routes>,
      { me: buildMe(), route: "/admin/inventario/insumo/8" },
    )

    expect(await screen.findByRole("heading", { name: "Aguardiente Antioqueño 750 ml" })).toBeInTheDocument()
    expect(screen.getByText("Consumo diario")).toBeInTheDocument()
    expect(screen.getByText("Llega al mínimo")).toBeInTheDocument()
    expect(screen.getByText("vie 9 oct")).toBeInTheDocument()

    const grafico = screen.getByRole("region", { name: "Stock al cierre de cada día y lo que viene si se consume igual" })
    // `null` es hueco rayado, nunca una barra en 0.
    expect(grafico.querySelectorAll("[data-hueco]")).toHaveLength(1)
    expect(grafico.querySelectorAll("[data-barra][data-fuera]")).toHaveLength(1)
    expect(grafico.querySelectorAll("[data-barra][data-futuro]")).toHaveLength(2)
    expect(within(grafico).getByText("hoy")).toBeInTheDocument()
    expect(within(grafico).getByText("Mínimo: 6 und")).toBeInTheDocument()
    expect(within(grafico).getByText("Llega al mínimo el vie 9 oct")).toBeInTheDocument()
    expect(within(grafico).getByText("Consume 0,7 und por día")).toBeInTheDocument()

    const causas = screen.getByRole("img", { name: /Entradas y salidas del libro por causa/ })
    const compra = causas.querySelector<HTMLElement>('[data-barra="sobra"]')!
    expect(compra.style.background).toBe("var(--data-1)")
    const venta = causas.querySelector<HTMLElement>('[data-barra="falta"]')!
    expect(venta.style.background).toBe("var(--diverge-falta)")
    expect(within(causas).getByText("+24 und")).toBeInTheDocument()
    expect(within(causas).getByText("−12,6 und")).toBeInTheDocument()

    await userEvent.click(screen.getByRole("button", { name: "Ver conteos y libro de movimientos" }))
    expect(screen.getByRole("region", { name: "Conteos por área" })).toBeInTheDocument()
  })
})
