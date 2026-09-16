import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import type { Me } from "@/api/auth"
import { ApiError } from "@/api/client"
import { renderWithProviders } from "@/test/utils"

import { QuickProductionPage } from "./QuickProductionPage"

const { listDevicePreparationsMock, producePreparationMock } = vi.hoisted(() => ({
  listDevicePreparationsMock: vi.fn(),
  producePreparationMock: vi.fn(),
}))

vi.mock("@/api/recipes", async () => {
  const actual = await vi.importActual<typeof import("@/api/recipes")>("@/api/recipes")
  return {
    ...actual,
    listDevicePreparations: listDevicePreparationsMock,
    producePreparation: producePreparationMock,
  }
})

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: ["counter"] },
    employee: { id: 2, name: "Ana", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  }
}

const PREPS = [
  { id: 1, name: "Caldo base", mode: "batch" as const, prefilled_qty: "5", standard_yield_unit: "l", shelf_life_days: 3 },
  { id: 2, name: "Hogao", mode: "exploded" as const, prefilled_qty: "2", standard_yield_unit: "kg", shelf_life_days: null },
]

function produceOut(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 10,
    preparation_id: 1,
    qty_expected: "5",
    qty_real: "5",
    unit: "l",
    variance_pct: "0.00",
    variance_alert: false,
    expiry_date: "2026-09-18",
    produced_at: "2026-09-15T10:00:00Z",
    ...overrides,
  }
}

async function enterPin(user: ReturnType<typeof userEvent.setup>, pin = "1234") {
  for (const digit of pin) {
    await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
  }
}

describe("QuickProductionPage", () => {
  it("sin catalog.preps no ofrece producción", () => {
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": false }) })
    expect(screen.getByText(/no está habilitada/)).toBeInTheDocument()
    expect(listDevicePreparationsMock).not.toHaveBeenCalled()
  })

  it("sólo ofrece preparaciones en modo lote: las explotadas no se producen", async () => {
    listDevicePreparationsMock.mockResolvedValue(PREPS)
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": true }) })

    expect(await screen.findByText("Caldo base")).toBeInTheDocument()
    expect(screen.queryByText("Hogao")).not.toBeInTheDocument()
  })

  it("dos toques: tocar la preparación (cantidad precargada) + el PIN completo produce, sin botón «Confirmar» aparte", async () => {
    listDevicePreparationsMock.mockResolvedValue(PREPS)
    producePreparationMock.mockResolvedValue(produceOut())

    const user = userEvent.setup()
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": true }) })

    // TOQUE 1: elegir la preparación.
    await user.click(await screen.findByText("Caldo base"))
    expect(screen.getByLabelText("Cantidad real obtenida")).toHaveValue("5")
    expect(screen.queryByRole("button", { name: /^confirmar$/i })).not.toBeInTheDocument()

    // TOQUE 2: el cuarto dígito del PIN dispara el envío solo.
    await enterPin(user)

    await waitFor(() =>
      expect(producePreparationMock).toHaveBeenCalledWith(
        1,
        { qty_expected: "5", qty_real: "5", employee_pin: "1234" },
        expect.any(String),
      ),
    )
    // Nunca pinta costo ni margen: la ruta de dispositivo no los recibe.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument()
  })

  it("si el real difiere del esperado, avisa la variación (no bloquea)", async () => {
    listDevicePreparationsMock.mockResolvedValue(PREPS)
    producePreparationMock.mockResolvedValue(
      produceOut({ qty_real: "4", variance_pct: "20.00", variance_alert: true }),
    )

    const user = userEvent.setup()
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": true }) })

    await user.click(await screen.findByText("Caldo base"))
    const qtyInput = screen.getByLabelText("Cantidad real obtenida")
    await user.clear(qtyInput)
    await user.type(qtyInput, "4")
    // El `PinPad` queda `disabled` mientras el campo de cantidad tiene el
    // foco (mitigación del defecto conocido de `PinPad`, ver el componente);
    // hay que sacarle el foco antes de poder tocar sus dígitos.
    await user.tab()
    await enterPin(user)

    await waitFor(() =>
      expect(producePreparationMock).toHaveBeenCalledWith(
        1,
        { qty_expected: "5", qty_real: "4", employee_pin: "1234" },
        expect.any(String),
      ),
    )
  })

  it("una Idempotency-Key nueva por intento: dos producciones seguidas no repiten la clave", async () => {
    listDevicePreparationsMock.mockResolvedValue(PREPS)
    producePreparationMock.mockResolvedValue(produceOut())

    const user = userEvent.setup()
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": true }) })

    await user.click(await screen.findByText("Caldo base"))
    await enterPin(user)
    await waitFor(() => expect(producePreparationMock).toHaveBeenCalledTimes(1))
    const firstKey = producePreparationMock.mock.calls[0]![2]

    await user.click(await screen.findByText("Caldo base"))
    await enterPin(user)
    await waitFor(() => expect(producePreparationMock).toHaveBeenCalledTimes(2))
    const secondKey = producePreparationMock.mock.calls[1]![2]

    expect(secondKey).not.toBe(firstKey)
  })

  it("ante 409 de concurrencia (misma clave en vuelo) mantiene la clave en vez de duplicar el lote", async () => {
    listDevicePreparationsMock.mockResolvedValue(PREPS)
    producePreparationMock
      .mockRejectedValueOnce(
        new ApiError(409, "IDEMPOTENCY_IN_PROGRESS", "Esta operación ya se está procesando; esperá un momento"),
      )
      .mockResolvedValueOnce(produceOut())

    const user = userEvent.setup()
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": true }) })

    await user.click(await screen.findByText("Caldo base"))
    await enterPin(user)
    await screen.findByRole("alert")

    await enterPin(user)
    await waitFor(() => expect(producePreparationMock).toHaveBeenCalledTimes(2))
    const [firstKey, secondKey] = producePreparationMock.mock.calls.map((call) => call[2])
    expect(secondKey).toBe(firstKey)
  })

  it("ante un PIN inválido (u otro error de negocio) genera una clave nueva para no chocar con IDEMPOTENCY_MISMATCH", async () => {
    listDevicePreparationsMock.mockResolvedValue(PREPS)
    producePreparationMock
      .mockRejectedValueOnce(new ApiError(400, "EMPLOYEE_PIN_INVALID", "El PIN no coincide con el operador"))
      .mockResolvedValueOnce(produceOut())

    const user = userEvent.setup()
    renderWithProviders(<QuickProductionPage />, { me: deviceMe({ "catalog.preps": true }) })

    await user.click(await screen.findByText("Caldo base"))
    await enterPin(user, "1111")
    await screen.findByText("El PIN no coincide con el operador")

    await enterPin(user, "2222")
    await waitFor(() => expect(producePreparationMock).toHaveBeenCalledTimes(2))
    const [firstKey, secondKey] = producePreparationMock.mock.calls.map((call) => call[2])
    expect(secondKey).not.toBe(firstKey)
  })
})
