import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { SalesSettings } from "@/api/stores"
import { buildMe, renderWithProviders } from "@/test/utils"

import { SalesSection } from "../SalesSection"

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
}

describe("SalesSection — los supuestos del panel viven en Ajustes", () => {
  it("muestra los cuatro supuestos con sus valores y dice qué raya mueve cada uno", async () => {
    getSalesSettingsMock.mockResolvedValue(DEFAULTS)
    renderWithProviders(<SalesSection storeId={1} />, { me: buildMe() })

    expect(await screen.findByLabelText("Margen meta por categoría (%)")).toHaveValue(65)
    expect(screen.getByLabelText("Mesa larga (minutos)")).toHaveValue(60)
    expect(screen.getByLabelText("Tiquete demorado (minutos)")).toHaveValue(20)
    expect(screen.getByLabelText("Comandas por hora que atiende un mesero")).toHaveValue(7)
    expect(screen.getByText("Los supuestos del panel")).toBeInTheDocument()
    expect(screen.getByText(/El umbral de retiro está en Caja/)).toBeInTheDocument()
  })

  it("guarda un supuesto cambiado junto con el resto de la configuración", async () => {
    getSalesSettingsMock.mockResolvedValue(DEFAULTS)
    setSalesSettingsMock.mockResolvedValue({ ...DEFAULTS, long_table_minutes: 90 })
    const user = userEvent.setup()
    renderWithProviders(<SalesSection storeId={1} />, { me: buildMe() })

    const campo = await screen.findByLabelText("Mesa larga (minutos)")
    await user.clear(campo)
    await user.type(campo, "90")
    await user.click(screen.getByRole("button", { name: "Guardar" }))
    // La confirmación nombra el supuesto y la raya que mueve.
    const dialogo = await screen.findByRole("alertdialog")
    expect(dialogo).toHaveTextContent("Mesa larga")
    expect(dialogo).toHaveTextContent("Cambia la raya de Hoy › Salón")
    expect(dialogo).toHaveTextContent(/60 min\s*→\s*90 min/)
    await user.click(within(dialogo).getByRole("button", { name: "Guardar" }))
    await waitFor(() => expect(setSalesSettingsMock).toHaveBeenCalled())
    expect(setSalesSettingsMock.mock.calls[0]![1]).toMatchObject({ long_table_minutes: 90, margin_target_pct: 65 })
  })
})
