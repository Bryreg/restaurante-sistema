import { screen, within } from "@testing-library/react"
import { Route, Routes } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import type { Me } from "@/api/auth"
import { renderWithProviders } from "@/test/utils"

import PosLayout from "../PosLayout"

/**
 * El KDS es una pantalla de ESTACIÓN: la cocina la mira con las manos
 * sucias y la persona vence a los 3 minutos (`EMPLOYEE_SESSION_MINUTES`).
 * Mirarla no puede mandar a «Quién opera»; el PIN se pide al marcar algo
 * (`features/kitchen/KdsPage.tsx`). Las demás pantallas del salón siguen
 * exigiendo persona.
 */

vi.mock("@/features/shifts", () => ({
  shiftsFeature: {
    posRoutes: [],
    adminRoutes: [],
    adminNav: [],
    posNav: [{ to: "/pos/turno", label: "Turno", posGroup: "caja" }],
    ShiftStatusStrip: () => <div data-testid="shift-status-strip" />,
  },
}))

function deviceMe(features: Record<string, boolean>, employee: Me["employee"]): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  }
}

function renderAt(route: string, me: Me) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos" element={<PosLayout />}>
        <Route index element={<div>inicio</div>} />
        <Route path="kds" element={<div>pantalla de cocina</div>} />
        <Route path="mesas" element={<div>mesas</div>} />
      </Route>
      <Route path="/pos/identify" element={<div>Quién opera</div>} />
    </Routes>,
    { route, me },
  )
}

const KDS = { "kitchen.view": true, "kitchen.kds": true, "pos.tables": true }

describe("PosLayout — el KDS no exige persona para mirarse", () => {
  it("sin persona, el KDS se queda en pantalla (no manda a «Quién opera»)", () => {
    renderAt("/pos/kds", deviceMe(KDS, null))

    expect(screen.getByText("pantalla de cocina")).toBeInTheDocument()
    expect(screen.queryByText("Quién opera")).not.toBeInTheDocument()
    expect(screen.getByText(/nadie identificado/i)).toBeInTheDocument()
  })

  it("sin persona, cualquier otra pantalla del salón sigue mandando a «Quién opera»", () => {
    renderAt("/pos/mesas", deviceMe(KDS, null))

    expect(screen.getByText("Quién opera")).toBeInTheDocument()
    expect(screen.queryByText("mesas")).not.toBeInTheDocument()
  })

  it("con el KDS encendido la barra ofrece UNA pantalla de cocina, no la vista mínima además", async () => {
    renderAt("/pos", deviceMe(KDS, { id: 7, name: "Ana", role: "operator", can_charge: false }))

    const barra = await screen.findByRole("navigation", { name: "Secciones del salón" })
    const rotulos = within(barra)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
    expect(rotulos).toContain("/pos/kds")
    expect(rotulos).not.toContain("/pos/cocina")
  })

  it("con el KDS apagado la vista mínima de Cocina sigue en la barra", async () => {
    renderAt(
      "/pos",
      deviceMe({ "kitchen.view": true, "kitchen.kds": false }, { id: 7, name: "Ana", role: "operator", can_charge: false }),
    )

    const barra = await screen.findByRole("navigation", { name: "Secciones del salón" })
    const rotulos = within(barra)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"))
    expect(rotulos).toContain("/pos/cocina")
    expect(rotulos).not.toContain("/pos/kds")
  })
})
