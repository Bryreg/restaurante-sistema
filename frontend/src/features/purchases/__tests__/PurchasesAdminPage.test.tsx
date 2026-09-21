import { screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { PurchasesAdminPage } from "../PurchasesAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

const { listSuppliersMock } = vi.hoisted(() => ({ listSuppliersMock: vi.fn().mockResolvedValue([]) }))

vi.mock("@/api/purchases", async () => {
  const actual = await vi.importActual<typeof import("@/api/purchases")>("@/api/purchases")
  return { ...actual, listSuppliers: listSuppliersMock }
})

describe("PurchasesAdminPage — toda la sección detrás de hasFeature(\"purchases\")", () => {
  it("con purchases apagada explica qué la prende, no una pantalla rota, y no pide nada al servidor", () => {
    renderWithProviders(<PurchasesAdminPage />, { me: buildMe({ features: { purchases: false } }), route: "/admin/compras" })

    // El vacío por «función apagada» (patrón 13) tiene que nombrar TRES
    // cosas: qué función es, con qué clave se prende y dónde se prende. El
    // texto viejo («Compras no está habilitado») sólo decía la primera.
    expect(screen.getByText(/no está encendida/i)).toBeInTheDocument()
    expect(screen.getByText("purchases")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /encenderla en funciones/i })).toBeInTheDocument()
    expect(listSuppliersMock).not.toHaveBeenCalled()
  })

  it("con purchases encendida muestra las tres pestañas, con Proveedores por defecto", async () => {
    renderWithProviders(<PurchasesAdminPage />, { me: buildMe({ features: { purchases: true } }), route: "/admin/compras" })

    await waitFor(() => expect(listSuppliersMock).toHaveBeenCalledWith(1, { active: true }))
    expect(screen.getByRole("tab", { name: "Proveedores", selected: true })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Recepciones" })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Cuentas por pagar" })).toBeInTheDocument()
  })

  it("?tab=cuentas-por-pagar abre directo en Cuentas por pagar", async () => {
    renderWithProviders(<PurchasesAdminPage />, {
      me: buildMe({ features: { purchases: true } }),
      route: "/admin/compras?tab=cuentas-por-pagar",
    })

    await waitFor(() => expect(screen.getByRole("tab", { name: "Cuentas por pagar", selected: true })).toBeInTheDocument())
  })
})
