import { screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { AuthorizerDialog } from "../AuthorizerDialog"

const { listDeviceEmployeesMock } = vi.hoisted(() => ({ listDeviceEmployeesMock: vi.fn() }))

vi.mock("@/api/employees", async () => {
  const actual = await vi.importActual<typeof import("@/api/employees")>("@/api/employees")
  return { ...actual, listDeviceEmployees: listDeviceEmployeesMock }
})

const PERSONAL = [
  { id: 1, name: "Admin Demo", role: "admin" },
  { id: 2, name: "Supervisor Demo", role: "supervisor" },
  { id: 3, name: "Yuliana Pérez", role: "operator" },
]

function dibujar(features: Record<string, boolean>) {
  return renderWithProviders(
    <AuthorizerDialog open onOpenChange={() => {}} onSubmit={() => {}} reason="Anular un plato ya enviado." />,
    { me: buildMe({ kind: "device", features }) },
  )
}

describe("AuthorizerDialog — toda autorización nombra a quién pedírsela", () => {
  beforeEach(() => listDeviceEmployeesMock.mockResolvedValue(PERSONAL))

  it("con supervisores habilitados nombra a administradores y supervisores, nunca a un operador", async () => {
    dibujar({ "roles.supervisor": true })
    expect(await screen.findByText("Admin Demo · Supervisor Demo")).toBeInTheDocument()
    expect(screen.queryByText(/Yuliana/)).not.toBeInTheDocument()
  })

  it("sin la función de supervisores sólo nombra administradores: el servidor no aceptaría otro PIN", async () => {
    dibujar({ "roles.supervisor": false })
    expect(await screen.findByText("Admin Demo")).toBeInTheDocument()
    expect(screen.queryByText(/Supervisor Demo/)).not.toBeInTheDocument()
  })
})
