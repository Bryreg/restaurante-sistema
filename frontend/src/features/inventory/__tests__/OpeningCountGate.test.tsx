/**
 * La apertura del conteo por área es obligatoria (decisión 5 del dueño):
 *
 * - a quien el servidor dice `required`, las pantallas del POS le muestran
 *   «Primero el conteo de apertura» con el camino al conteo;
 * - el KDS y la vista de cocina NO se frenan: muestran un aviso rojo fijo con
 *   las áreas pendientes (los tiquetes no pueden parar);
 * - la pantalla de conteo no se tapa a sí misma;
 * - con la función apagada, ni consulta;
 * - cocina y bar llegan a Conteo después del PIN y, si no les falta nada,
 *   siguen solos a su pantalla de siempre.
 */
import { screen, waitFor } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DeviceOpeningGateOut } from "@/api/areaCounts"
import { buildMe, renderWithProviders } from "@/test/utils"

import { AreaCountPage } from "../AreaCountPage"
import { OpeningCountGate } from "../OpeningCountGate"

const mocks = vi.hoisted(() => ({
  getAreaCountGate: vi.fn(),
  getAreaCountSheet: vi.fn(),
}))

vi.mock("@/api/areaCounts", async () => {
  const actual = await vi.importActual<typeof import("@/api/areaCounts")>("@/api/areaCounts")
  return { ...actual, ...mocks }
})

function gate(overrides: Partial<DeviceOpeningGateOut> = {}): DeviceOpeningGateOut {
  return {
    business_date: "2026-09-26",
    required: true,
    area_id: 2,
    area_name: "Cocina",
    message: "Primero el conteo de apertura de Cocina: van 3 de 12 artículos.",
    pending: [{ area_id: 2, area_name: "Cocina", counted: 3, total: 12, full_count: false }],
    ...overrides,
  }
}

const FEATURES = {
  "inventory.perpetual": true,
  "inventory.shift_counts": true,
  "kitchen.kds": true,
}

function me(features: Record<string, boolean> = FEATURES, conPersona = true) {
  return buildMe({
    kind: "device",
    features,
    employee: conPersona ? { id: 7, name: "Kevin", role: "operator", can_charge: false, puesto: "cocina" } : null,
  })
}

function pantalla(route: string, meValue = me()) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/mesas" element={<OpeningCountGate>Mesas del salón</OpeningCountGate>} />
      <Route path="/pos/kds" element={<OpeningCountGate>Tiquetes</OpeningCountGate>} />
      <Route path="/pos/conteo" element={<OpeningCountGate>Pantalla de conteo</OpeningCountGate>} />
    </Routes>,
    { me: meValue, route },
  )
}

describe("OpeningCountGate", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
  })

  it("frena las pantallas del POS con el camino al conteo", async () => {
    mocks.getAreaCountGate.mockResolvedValue(gate())
    pantalla("/pos/mesas")
    expect(await screen.findByRole("heading", { name: "Primero el conteo de apertura" })).toBeInTheDocument()
    expect(screen.getByText(/van 3 de 12/)).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "Ir al conteo" })).toHaveAttribute("href", "/pos/conteo")
    expect(screen.getByRole("link", { name: "Ver tiquetes de cocina" })).toHaveAttribute("href", "/pos/kds")
    expect(screen.queryByText("Mesas del salón")).not.toBeInTheDocument()
  })

  it("sin apertura pendiente para esta persona, la pantalla se ve", async () => {
    mocks.getAreaCountGate.mockResolvedValue(gate({ required: false, message: null, area_id: null, area_name: null }))
    pantalla("/pos/mesas")
    expect(await screen.findByText("Mesas del salón")).toBeInTheDocument()
    await waitFor(() => expect(mocks.getAreaCountGate).toHaveBeenCalled())
    expect(screen.getByText("Mesas del salón")).toBeInTheDocument()
  })

  it("el KDS no se frena: aviso rojo fijo con las áreas pendientes, aun sin persona", async () => {
    mocks.getAreaCountGate.mockResolvedValue(gate({ required: false }))
    pantalla("/pos/kds", me(FEATURES, false))
    expect(screen.getByText("Tiquetes")).toBeInTheDocument()
    expect(await screen.findByText(/Falta el conteo de apertura: Cocina \(3 de 12\)/)).toBeInTheDocument()
    expect(screen.getByText("Tiquetes")).toBeInTheDocument()
  })

  it("la pantalla de conteo no se tapa, y con la función apagada ni consulta", async () => {
    mocks.getAreaCountGate.mockResolvedValue(gate())
    const { unmount } = pantalla("/pos/conteo")
    expect(screen.getByText("Pantalla de conteo")).toBeInTheDocument()
    expect(mocks.getAreaCountGate).not.toHaveBeenCalled()
    unmount()
    pantalla("/pos/mesas", me({ "inventory.perpetual": true }))
    expect(screen.getByText("Mesas del salón")).toBeInTheDocument()
    expect(mocks.getAreaCountGate).not.toHaveBeenCalled()
  })
})

describe("AreaCountPage — la llegada después del PIN", () => {
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset()
    mocks.getAreaCountSheet.mockReturnValue(new Promise(() => {}))
  })

  function llegada() {
    return renderWithProviders(
      <Routes>
        <Route path="/pos/conteo" element={<AreaCountPage />} />
        <Route path="/pos/kds" element={<p>Tiquetes</p>} />
      </Routes>,
      { me: me(), route: "/pos/conteo?inicio=1" },
    )
  }

  it("si ya no falta la apertura, sigue sola al KDS", async () => {
    mocks.getAreaCountGate.mockResolvedValue(gate({ required: false }))
    llegada()
    expect(await screen.findByText("Tiquetes")).toBeInTheDocument()
  })

  it("si falta, se queda en el conteo", async () => {
    mocks.getAreaCountGate.mockResolvedValue(gate())
    llegada()
    expect(await screen.findByRole("heading", { name: "Conteo por área" })).toBeInTheDocument()
    await waitFor(() => expect(mocks.getAreaCountGate).toHaveBeenCalled())
    expect(screen.queryByText("Tiquetes")).not.toBeInTheDocument()
  })
})
