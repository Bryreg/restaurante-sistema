import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { SalesSettings } from "@/api/stores"
import { buildMe, renderWithProviders } from "@/test/utils"

import { SecuritySection } from "../SecuritySection"

const { getSalesSettingsMock, setSalesSettingsMock } = vi.hoisted(() => ({
  getSalesSettingsMock: vi.fn(),
  setSalesSettingsMock: vi.fn(),
}))

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores")
  return { ...actual, getSalesSettings: getSalesSettingsMock, setSalesSettings: setSalesSettingsMock }
})

const DEFAULTS: SalesSettings = {
  tip_suggested_pct: 10,
  discount_limit_pct: 10,
  discount_daily_limit_pct: 5,
  courtesy_shift_limit: 5,
  payment_methods: [],
  void_reasons: ["Error"],
  discount_reasons: ["Promo"],
  courtesy_reasons: ["Queja"],
  courses: [],
  stations: [],
  course_target_minutes: {},
  margin_target_pct: 65,
  long_table_minutes: 60,
  late_ticket_minutes: 20,
  orders_per_waiter: 7,
  invoice_threshold_uvt: 5,
  station_target_minutes: {},
  quick_notes: {},
  employee_session_minutes: null,
  pin_lock_attempts: null,
  pin_lock_minutes: null,
  period_low_base_orders: 20,
  daily_low_base_orders: 5,
  employee_session_minutes_default: 3,
  pin_lock_attempts_default: 5,
  pin_lock_minutes_default: 15,
}

describe("SecuritySection — Ajustes › Seguridad (antes dentro de Ventas)", () => {
  it("muestra los tres campos con los valores de fábrica como placeholder", async () => {
    getSalesSettingsMock.mockResolvedValue(DEFAULTS)
    renderWithProviders(<SecuritySection storeId={1} />, { me: buildMe() })

    const sesion = await screen.findByLabelText("Sesión de la persona (minutos sin usar)")
    expect(sesion).toHaveValue(null)
    expect(sesion).toHaveAttribute("placeholder", "3")
    expect(screen.getByLabelText("PIN equivocados antes del bloqueo")).toHaveAttribute("placeholder", "5")
    expect(screen.getByLabelText("Minutos de bloqueo del PIN")).toHaveAttribute("placeholder", "15")
  })

  it("guarda sólo lo de seguridad, sobre la configuración de ventas tal cual se leyó", async () => {
    getSalesSettingsMock.mockResolvedValue(DEFAULTS)
    setSalesSettingsMock.mockResolvedValue({ ...DEFAULTS, pin_lock_attempts: 3 })
    const user = userEvent.setup()
    renderWithProviders(<SecuritySection storeId={1} />, { me: buildMe() })

    await user.type(await screen.findByLabelText("PIN equivocados antes del bloqueo"), "3")
    await user.click(screen.getByRole("button", { name: "Guardar" }))
    const dialogo = await screen.findByRole("alertdialog")
    expect(dialogo).toHaveTextContent("Intentos antes del bloqueo")
    expect(dialogo).toHaveTextContent(/el de fábrica\s*→\s*3/)
    await user.click(within(dialogo).getByRole("button", { name: "Guardar" }))

    await waitFor(() => expect(setSalesSettingsMock).toHaveBeenCalled())
    expect(setSalesSettingsMock.mock.calls[0]![1]).toEqual({ ...DEFAULTS, pin_lock_attempts: 3 })
  })
})
