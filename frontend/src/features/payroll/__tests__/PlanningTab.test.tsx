/**
 * Nómina › Planeación (auditoría e1): la grilla persona × día con el turno
 * planeado y lo que pasó en realidad tal como lo decide el servidor; planear
 * y quitar un turno con Idempotency-Key; copiar la semana anterior.
 */
import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ScheduleDayOut, ScheduleWeekOut } from "@/api/payroll"
import { buildMe, renderWithProviders } from "@/test/utils"

import { PlanningTab } from "../PlanningTab"

const { getScheduleMock, putPlannedShiftMock, voidPlannedShiftMock, copyPreviousWeekMock } = vi.hoisted(() => ({
  getScheduleMock: vi.fn(),
  putPlannedShiftMock: vi.fn(),
  voidPlannedShiftMock: vi.fn(),
  copyPreviousWeekMock: vi.fn(),
}))

vi.mock("@/api/payroll", async () => {
  const actual = await vi.importActual<typeof import("@/api/payroll")>("@/api/payroll")
  return {
    ...actual,
    getSchedule: getScheduleMock,
    putPlannedShift: putPlannedShiftMock,
    voidPlannedShift: voidPlannedShiftMock,
    copyPreviousWeek: copyPreviousWeekMock,
  }
})

const DAYS = ["2026-03-09", "2026-03-10", "2026-03-11", "2026-03-12", "2026-03-13", "2026-03-14", "2026-03-15"]

function empty(d: string): ScheduleDayOut {
  return { business_date: d, planned: null, actual_in_at: null, status: null, late_minutes: null }
}

function planned(id: number, d: string, start = "07:00", end = "15:00") {
  return {
    id,
    employee_id: 7,
    employee_name: "Ana",
    business_date: d,
    start,
    end,
    start_minute: 420,
    end_minute: 900,
    planned_minutes: 480,
    note: null,
    created_by_employee_name: "Admin",
  }
}

function week(): ScheduleWeekOut {
  return {
    store_id: 1,
    week_start: "2026-03-09",
    week_end: "2026-03-15",
    today: "2026-03-10",
    grace_minutes: 5,
    late_count: 1,
    no_show_count: 1,
    people: [
      {
        employee_id: 7,
        employee_name: "Ana",
        planned_minutes: 960,
        days: DAYS.map((d) =>
          d === "2026-03-09"
            ? { business_date: d, planned: planned(1, d), actual_in_at: null, status: "no_show", late_minutes: null }
            : d === "2026-03-10"
              ? { business_date: d, planned: planned(2, d), actual_in_at: "2026-03-10T12:12:00Z", status: "late", late_minutes: 12 }
              : empty(d),
        ),
      },
      { employee_id: 8, employee_name: "Luis", planned_minutes: 0, days: DAYS.map(empty) },
    ],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  getScheduleMock.mockResolvedValue(week())
})

describe("PlanningTab", () => {
  it("pinta lo planeado y lo que pasó tal como lo manda el servidor", async () => {
    renderWithProviders(<PlanningTab storeId={1} />, { me: buildMe() })

    const tarde = await screen.findByRole("button", { name: /Ana, .*07:00 a 15:00, Tarde 12 min\. Cambiar turno/ })
    expect(within(tarde).getByText("Tarde 12 min")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Ana, .*No vino\. Cambiar turno/ })).toBeInTheDocument()
    expect(screen.getByText(/llegada tarde/)).toBeInTheDocument()
    expect(screen.getAllByRole("button", { name: /Luis, .*sin turno\. Planear turno/ })).toHaveLength(7)
  })

  it("planear un día vacío propone las horas de su último turno y guarda con Idempotency-Key", async () => {
    putPlannedShiftMock.mockResolvedValue(planned(3, "2026-03-11"))
    const user = userEvent.setup()
    renderWithProviders(<PlanningTab storeId={1} />, { me: buildMe() })

    const celdas = await screen.findAllByRole("button", { name: /Ana, .*sin turno\. Planear turno/ })
    await user.click(celdas[0]!)
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByLabelText("Entrada")).toHaveValue("07:00")
    await user.type(within(dialog).getByLabelText("Nota (opcional)"), "Cubre a Luis")
    await user.click(within(dialog).getByRole("button", { name: "Guardar turno" }))

    await waitFor(() =>
      expect(putPlannedShiftMock).toHaveBeenCalledWith(
        1,
        { employee_id: 7, business_date: "2026-03-11", start: "07:00", end: "15:00", note: "Cubre a Luis" },
        expect.any(String),
      ),
    )
  })

  it("quitar un turno lo anula en el servidor (no lo borra)", async () => {
    voidPlannedShiftMock.mockResolvedValue(planned(2, "2026-03-10"))
    const user = userEvent.setup()
    renderWithProviders(<PlanningTab storeId={1} />, { me: buildMe() })

    await user.click(await screen.findByRole("button", { name: /Tarde 12 min\. Cambiar turno/ }))
    const dialog = await screen.findByRole("dialog")
    await user.click(within(dialog).getByRole("button", { name: "Quitar turno" }))
    await waitFor(() => expect(voidPlannedShiftMock).toHaveBeenCalledWith(1, 2, expect.any(String)))
  })

  it("copiar la semana anterior dice cuántos turnos copió y cuántos no", async () => {
    copyPreviousWeekMock.mockResolvedValue({ week_start: "2026-03-09", copied: 4, skipped: 1 })
    const user = userEvent.setup()
    renderWithProviders(<PlanningTab storeId={1} />, { me: buildMe() })

    await user.click(await screen.findByRole("button", { name: "Copiar la semana anterior" }))
    await waitFor(() => expect(copyPreviousWeekMock).toHaveBeenCalledWith(1, "2026-03-09", expect.any(String)))
    expect(await screen.findByText(/Se copiaron 4 turnos; 1 no se copiaron/)).toBeInTheDocument()
  })
})
