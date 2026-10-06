import { screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { OwnerHandOut } from "@/api/banking"
import { renderWithProviders } from "@/test/utils"

import { DIAS_SIN_CONSIGNAR_AVISO, OwnerHandTab } from "../OwnerHandTab"

const { getOwnerHandMock } = vi.hoisted(() => ({ getOwnerHandMock: vi.fn() }))

vi.mock("@/api/banking", async () => {
  const actual = await vi.importActual<typeof import("@/api/banking")>("@/api/banking")
  return { ...actual, getOwnerHand: getOwnerHandMock }
})

const BASE: OwnerHandOut = {
  withdrawn: 14_531_600,
  deposited: 8_259_600,
  spent: 841_400,
  balance: 5_430_600,
  oldest_undeposited_date: "2026-09-21",
  oldest_undeposited_days: 2,
  reason: null,
} as OwnerHandOut

function tarjeta(): HTMLElement {
  return screen.getByText("Plata más vieja sin consignar").closest('[class*="rounded-lg"]') as HTMLElement
}

describe("OwnerHandTab — cuánto lleva la plata sin consignar (informe #15)", () => {
  it("dentro del umbral: los días tal como llegan, sin alerta", async () => {
    getOwnerHandMock.mockResolvedValue(BASE)
    renderWithProviders(<OwnerHandTab storeId={1} />)

    expect(await screen.findByText("Hace 2 días")).toBeInTheDocument()
    expect(tarjeta()).toHaveTextContent("Del cierre del lun 21 sep.")
    expect(tarjeta().className).not.toContain("bg-warning")
  })

  it(`pasado de ${DIAS_SIN_CONSIGNAR_AVISO} días va en ámbar y dice que hay que consignar`, async () => {
    getOwnerHandMock.mockResolvedValue({ ...BASE, oldest_undeposited_date: "2026-09-17", oldest_undeposited_days: 6 })
    renderWithProviders(<OwnerHandTab storeId={1} />)

    expect(await screen.findByText("Hace 6 días")).toBeInTheDocument()
    expect(tarjeta().className).toContain("bg-warning")
    expect(tarjeta()).toHaveTextContent(/Pasa de 3 días fuera del banco: consignala/)
  })

  it("sin plata por consignar (los dos null) dice «al día», no un cero ni un sin dato", async () => {
    getOwnerHandMock.mockResolvedValue({ ...BASE, oldest_undeposited_date: null, oldest_undeposited_days: null })
    renderWithProviders(<OwnerHandTab storeId={1} />)

    expect(await screen.findByText("Al día")).toBeInTheDocument()
    expect(tarjeta()).toHaveTextContent("No queda plata de ningún cierre por consignar.")
  })
})

describe("OwnerHandTab — c9: sólo la plata que salió del cajón", () => {
  it("explica la fórmula en pantalla y publica lo que sigue en el cajón sin contarlo", async () => {
    getOwnerHandMock.mockResolvedValue({
      ...BASE,
      withdrawn_from_pickups: 4_000_000,
      withdrawn_from_envelopes: 10_531_600,
      spent_on_tips: 500_000,
      spent_on_refunds: 141_400,
      spent_on_expenses: 200_000,
      still_in_drawer: 697_900,
      deposited_from_drawer: 300_000,
    })
    renderWithProviders(<OwnerHandTab storeId={1} />)

    const formula = await screen.findByTestId("owner-hand-formula")
    expect(formula).toHaveTextContent("retirado − consignado − gastado")
    expect(formula).toHaveTextContent(/sobres entregados/i)
    expect(formula).toHaveTextContent(/De la mano del dueño/)
    expect(formula).toHaveTextContent("$ 697.900")
    expect(screen.getAllByText("Sobres entregados").length).toBeGreaterThan(0)
    expect(screen.getByText("$ 10.531.600")).toBeInTheDocument()
    expect(screen.getByText("Gastado en gastos y obligaciones")).toBeInTheDocument()
    expect(screen.getByText("$ 200.000")).toBeInTheDocument()
  })
})
