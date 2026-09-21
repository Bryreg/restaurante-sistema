import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { ApiError } from "@/api/client"
import type { CashSettings } from "@/api/stores"
import { buildMe, renderWithProviders } from "@/test/utils"

import { CashSection } from "../CashSection"

const { getCashSettingsMock, setCashSettingsMock } = vi.hoisted(() => ({
  getCashSettingsMock: vi.fn(),
  setCashSettingsMock: vi.fn(),
}))

vi.mock("@/api/stores", async () => {
  const actual = await vi.importActual<typeof import("@/api/stores")>("@/api/stores")
  return { ...actual, getCashSettings: getCashSettingsMock, setCashSettings: setCashSettingsMock }
})

const DEFAULTS: CashSettings = {
  opening_cash_fixed: 200_000,
  cash_reserve_default: 0,
  tolerance_unknown_cause: 20_000,
  critical_difference: 100_000,
  cash_pickup_threshold: 500_000,
  petty_cash_limit: 50_000,
  photo_required_on_close: true,
  photo_required_on_pickup: true,
  streak_alert_shifts: 3,
}

const ME = buildMe()

/** `formatCOP` separa el `$` con un espacio duro: se busca por la cifra. */
function bandas(): HTMLElement {
  return screen.getByRole("list")
}

describe("CashSection — Ajustes → Caja (SPEC-NEGOCIO §3.2)", () => {
  it("no ofrece «Tolerancia con causa identificada»: el ajuste muerto se fue", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    await screen.findByLabelText("Tolerancia sin causa identificada")
    expect(screen.queryByLabelText(/tolerancia con causa identificada/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/tolerancia con causa identificada/i)).not.toBeInTheDocument()
    // Las dos fronteras que el cierre SÍ lee siguen siendo editables.
    expect(screen.getByLabelText("Diferencia crítica")).toBeInTheDocument()
  })

  it("muestra las tres bandas derivadas de las dos fronteras, con las dos cifras reales", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    const lista = await waitFor(() => bandas())
    const items = within(lista).getAllByRole("listitem")
    expect(items).toHaveLength(3)

    expect(items[0]).toHaveTextContent(/Hasta\s*\$?\s*20\.000/)
    expect(items[0]).toHaveTextContent(/Sin identificar/i)

    expect(items[1]).toHaveTextContent(/Más de\s*\$?\s*20\.000/)
    expect(items[1]).toHaveTextContent(/menos de\s*\$?\s*100\.000/)
    expect(items[1]).toHaveTextContent(/la causa debe ser identificada/i)

    expect(items[2]).toHaveTextContent(/Desde\s*\$?\s*100\.000/)
    expect(items[2]).toHaveTextContent(/cr[ií]tica al administrador/i)
  })

  it("dice que ninguna banda bloquea el cierre (lo que la spec dice y la pantalla callaba)", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    expect(await screen.findByText(/ninguna de las tres bloquea el cierre/i)).toBeInTheDocument()
    expect(screen.getByText(/turno abandonado/i)).toBeInTheDocument()
  })

  it("las bandas se mueven con la frontera que se teclea, sin guardar todavía", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)
    const user = userEvent.setup()

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    const tolerancia = await screen.findByLabelText("Tolerancia sin causa identificada")
    await user.clear(tolerancia)
    await user.type(tolerancia, "35000")
    await user.tab()

    await waitFor(() => {
      expect(within(bandas()).getAllByRole("listitem")[0]).toHaveTextContent(/Hasta\s*\$?\s*35\.000/)
    })
    expect(within(bandas()).getAllByRole("listitem")[1]).toHaveTextContent(/Más de\s*\$?\s*35\.000/)
    expect(setCashSettingsMock).not.toHaveBeenCalled()
  })

  it("con las fronteras invertidas avisa y nombra la acción correctiva, en vez de inventar una banda al revés", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)
    const user = userEvent.setup()

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    const tolerancia = await screen.findByLabelText("Tolerancia sin causa identificada")
    await user.clear(tolerancia)
    await user.type(tolerancia, "200000")
    await user.tab()

    const aviso = await screen.findByText(/sub[ií] la diferencia cr[ií]tica o baj[áa] la tolerancia/i)
    expect(aviso).toBeInTheDocument()
    // Y no se dibuja «Más de $200.000 y menos de $100.000».
    expect(screen.queryByRole("list")).not.toBeInTheDocument()
  })

  it("muestra el error del servidor sin romperse cuando rechaza el orden invertido", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)
    setCashSettingsMock.mockRejectedValue(
      new ApiError(
        400,
        "CRITICAL_BELOW_TOLERANCE",
        "La diferencia crítica ($100000) tiene que ser mayor que la tolerancia sin causa identificada ($200000): subí la diferencia crítica o bajá la tolerancia",
      ),
    )
    const user = userEvent.setup()

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    // La barra de guardado sólo se activa con un cambio pendiente
    // (`docs/PATRONES-ADMIN.md` § 12): sin cambios dice «Sin cambios» y el
    // botón está apagado. Así que primero se cambia algo, y recién ahí se
    // guarda — que es lo que hace un dueño de verdad.
    const critica = await screen.findByLabelText("Diferencia crítica")
    await user.clear(critica)
    await user.type(critica, "150000")
    await user.tab()
    await user.click(screen.getByRole("button", { name: "Guardar" }))
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Guardar" }))

    await waitFor(() => {
      const alertas = screen.getAllByRole("alert")
      expect(alertas.some((el) => /tiene que ser mayor que la tolerancia/i.test(el.textContent ?? ""))).toBe(true)
    })
    // La pantalla sigue en pie y se puede volver a intentar: el cambio sigue
    // pendiente, así que la barra sigue activa.
    expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled()
  })

  it("guarda las dos fronteras cuando el orden es válido", async () => {
    getCashSettingsMock.mockResolvedValue(DEFAULTS)
    setCashSettingsMock.mockResolvedValue({ ...DEFAULTS, critical_difference: 150_000 })
    const user = userEvent.setup()

    renderWithProviders(<CashSection storeId={1} />, { me: ME })

    const critica = await screen.findByLabelText("Diferencia crítica")
    await user.clear(critica)
    await user.type(critica, "150000")
    await user.tab()
    await user.click(screen.getByRole("button", { name: "Guardar" }))
    // La barra confirma enumerando los cambios, uno por uno, con el valor
    // viejo tachado (§ 12). Guardar son dos pasos a propósito.
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Guardar" }))

    await waitFor(() => expect(setCashSettingsMock).toHaveBeenCalledTimes(1))
    const [, body] = setCashSettingsMock.mock.calls[0] as [number, CashSettings]
    expect(body.critical_difference).toBe(150_000)
    expect(body.tolerance_unknown_cause).toBe(20_000)
    expect(body).not.toHaveProperty("tolerance_identified_cause")
  })
})
