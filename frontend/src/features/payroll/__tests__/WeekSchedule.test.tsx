/**
 * Nómina › Horario de la semana (decisión del dueño, 2026-09-29): una barra
 * vertical por persona y día, lado a lado y nunca montadas; la jornada en
 * curso y la salida olvidada marcadas; la leyenda con el total del servidor;
 * y la tabla para lectores de pantalla. Es la vista por defecto de Nómina y
 * las demás pestañas pasan a «Más».
 */
import { screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { WeekScheduleOut } from "@/api/payroll"
import { buildMe, renderWithProviders } from "@/test/utils"

import { PayrollAdminPage } from "../PayrollAdminPage"
import { WeekScheduleTab } from "../WeekScheduleTab"
import { axisFor, layoutWeek, shiftWeek } from "../weekSchedule"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { getWeekScheduleMock } = vi.hoisted(() => ({ getWeekScheduleMock: vi.fn() }))

vi.mock("@/api/payroll", async () => {
  const actual = await vi.importActual<typeof import("@/api/payroll")>("@/api/payroll")
  return { ...actual, getWeekSchedule: getWeekScheduleMock }
})

const seg = (
  start_offset_min: number,
  end_offset_min: number | null,
  status: "closed" | "open" | "review" = "closed",
  hours: string | null = null,
) => ({
  start: "2026-09-29T13:00:00Z",
  end: end_offset_min === null ? null : "2026-09-29T21:00:00Z",
  start_offset_min,
  end_offset_min,
  status,
  minutes: hours === null ? null : 60,
  hours,
})

/** Corte a las 6: el minuto 0 del día operativo son las 6 a. m. */
function schedule(): WeekScheduleOut {
  return {
    store_id: 1,
    week_start: "2026-09-28",
    week_end: "2026-10-04",
    days: ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"],
    day_start_hour: 6,
    now: "2026-09-30T19:00:00Z",
    today: "2026-09-30",
    people: [
      {
        employee_id: 11,
        employee_name: "Ana Cocina",
        total_minutes: 900,
        total_hours: "15.00",
        review_count: 0,
        days: [
          // Lunes: dos tramos (pausa en el medio), de 8 a 12 y de 13 a 17.
          { business_date: "2026-09-28", segments: [seg(120, 360, "closed", "4.00"), seg(420, 660, "closed", "4.00")], minutes: 480, hours: "8.00" },
          // Miércoles (hoy): sigue trabajando desde las 7.
          { business_date: "2026-09-30", segments: [seg(60, 480, "open", "7.00")], minutes: 420, hours: "7.00" },
        ],
      },
      {
        employee_id: 12,
        employee_name: "Beto Salón",
        total_minutes: 0,
        total_hours: "0.00",
        review_count: 1,
        days: [
          // Lunes, a la misma hora que Ana: no puede montarse sobre ella.
          { business_date: "2026-09-28", segments: [seg(180, null, "review")], minutes: 0, hours: "0.00" },
        ],
      },
    ],
  }
}

describe("layoutWeek — una barra por persona, lado a lado", () => {
  it("el mismo día, dos personas van en carriles distintos que no se cruzan", () => {
    const [lunes, martes, miercoles] = layoutWeek(schedule())
    const ana = lunes.bars.filter((b) => b.employeeId === 11)
    const beto = lunes.bars.filter((b) => b.employeeId === 12)
    expect(ana).toHaveLength(2)
    expect(new Set(ana.map((b) => b.lane))).toEqual(new Set([0]))
    expect(beto.map((b) => b.lane)).toEqual([1])
    for (const b of lunes.bars) expect(b.lanes).toBe(2)
    // Los intervalos horizontales [carril/carriles, (carril+1)/carriles) no se solapan.
    const x = (b: { lane: number; lanes: number }) => [b.lane / b.lanes, (b.lane + 1) / b.lanes]
    const [a0, a1] = x(ana[0])
    const [b0, b1] = x(beto[0])
    expect(a1 <= b0 || b1 <= a0).toBe(true)
    // Un día sin nadie no tiene barras; un día con una sola persona le da todo el ancho.
    expect(martes.bars).toEqual([])
    expect(miercoles.bars.map((b) => [b.lane, b.lanes])).toEqual([[0, 1]])
    expect(miercoles.isToday).toBe(true)
  })

  it("la persona tiene el mismo color todos los días, y la pausa es un hueco en su carril", () => {
    const cols = layoutWeek(schedule())
    const colores = cols.flatMap((c) => c.bars.filter((b) => b.employeeId === 11).map((b) => b.color))
    expect(new Set(colores).size).toBe(1)
    const [tramo1, tramo2] = cols[0].bars.filter((b) => b.employeeId === 11)
    expect(tramo1.endMin).toBeLessThan(tramo2.startMin)
  })

  it("el eje va de 6 a. m. a 12 a. m. y se estira si alguien se sale", () => {
    expect(axisFor(schedule())).toEqual({ fromMin: 0, toMin: 18 * 60 })
    const tarde = schedule()
    tarde.people[0].days[0].segments.push(seg(1100, 1170, "closed", "1.17"))
    expect(axisFor(tarde).toMin).toBe(20 * 60)
  })

  it("la semana anterior y la siguiente son lunes ± 7 días", () => {
    expect(shiftWeek("2026-09-28", -1)).toBe("2026-09-21")
    expect(shiftWeek("2026-09-28", 1)).toBe("2026-10-05")
  })
})

describe("WeekScheduleTab", () => {
  it("dibuja las barras, marca la jornada en curso y la salida a revisar, y la leyenda trae el total del servidor", async () => {
    getWeekScheduleMock.mockResolvedValue(schedule())
    const { container } = renderWithProviders(<WeekScheduleTab storeId={1} />, { me: buildMe({ features: { payroll: true } }) })

    expect(await screen.findByText("Semana del lun 28 sep al dom 4 oct")).toBeInTheDocument()
    const barras = container.querySelectorAll("[data-bar]")
    expect(barras).toHaveLength(4)
    expect(container.querySelectorAll('[data-marca="en-curso"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-marca="a-revisar"]')).toHaveLength(1)
    const lunes = container.querySelector('[data-day="2026-09-28"]') as HTMLElement
    const lefts = [...lunes.querySelectorAll<HTMLElement>("[data-bar]")].map((b) => [b.style.left, b.style.width])
    expect(lefts).toEqual([
      ["0%", "50%"],
      ["0%", "50%"],
      ["50%", "50%"],
    ])

    const leyenda = screen.getByRole("list", { name: "Personas de la semana y sus horas" })
    expect(within(leyenda).getByText("15.00 h")).toBeInTheDocument()
    expect(within(leyenda).getByText("1 salida a revisar")).toBeInTheDocument()

    // La descarga de la semana es del servidor.
    expect(screen.getByRole("link", { name: /Descargar la semana/ })).toHaveAttribute(
      "href",
      "/api/v1/admin/payroll/week-schedule?store_id=1&week_of=2026-09-28&format=csv",
    )
  })

  it("la tabla gemela está para lectores de pantalla y se puede mostrar", async () => {
    getWeekScheduleMock.mockResolvedValue(schedule())
    renderWithProviders(<WeekScheduleTab storeId={1} />, { me: buildMe({ features: { payroll: true } }) })

    const tabla = await screen.findByRole("table")
    expect(within(tabla).getAllByRole("row")).toHaveLength(1 + 4)
    expect(within(tabla).getByText("en curso")).toBeInTheDocument()
    expect(within(tabla).getByText("salida a revisar")).toBeInTheDocument()
    expect(within(tabla).getByText("no suma")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Ver tabla" }))
    expect(screen.getByRole("button", { name: "Ver gráfico" })).toBeInTheDocument()
  })

  it("la semana anterior pide el lunes de antes; «Esta semana» vuelve a la de hoy", async () => {
    getWeekScheduleMock.mockResolvedValue(schedule())
    renderWithProviders(<WeekScheduleTab storeId={1} />, { me: buildMe({ features: { payroll: true } }) })

    await screen.findByText("Semana del lun 28 sep al dom 4 oct")
    expect(screen.getByRole("button", { name: "Esta semana" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Semana siguiente" })).toBeDisabled()
    await userEvent.click(screen.getByRole("button", { name: "Semana anterior" }))
    expect(getWeekScheduleMock).toHaveBeenLastCalledWith({ storeId: 1, weekOf: "2026-09-21" })
  })

  it("sin nadie en la semana lo dice, sin un gráfico vacío", async () => {
    getWeekScheduleMock.mockResolvedValue({ ...schedule(), people: [] })
    const { container } = renderWithProviders(<WeekScheduleTab storeId={1} />, { me: buildMe({ features: { payroll: true } }) })
    expect(await screen.findByText("Nadie marcó entrada esta semana")).toBeInTheDocument()
    expect(container.querySelectorAll("[data-bar]")).toHaveLength(0)
  })
})

describe("Nómina: el horario de la semana es la vista por defecto", () => {
  it("abre en «Horario de la semana» y manda las demás pestañas a «Más»", async () => {
    getWeekScheduleMock.mockResolvedValue(schedule())
    renderWithProviders(<PayrollAdminPage />, { me: buildMe({ features: { payroll: true, "pos.tips": true } }) })

    expect(await screen.findByRole("tab", { name: "Horario de la semana", selected: true })).toBeInTheDocument()
    expect(screen.queryByRole("tab", { name: "Horas" })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: /^Más/ }))
    for (const nombre of ["Horas", "Liquidaciones", "Tarifas y calendario", "Tablas de recargos", "Propinas"]) {
      expect(await screen.findByRole("menuitem", { name: nombre })).toBeInTheDocument()
    }
  })
})
