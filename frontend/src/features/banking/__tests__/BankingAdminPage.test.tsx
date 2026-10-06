/**
 * c10: el libro, la mano del dueño y las conciliaciones se mudaron a Plata
 * (`/admin/plata`) con los mismos `?tab=`; un marcador viejo de
 * `/admin/banco?tab=…` tiene que seguir llegando.
 */
import { screen } from "@testing-library/react"
import { Route, Routes, useLocation } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"

import { buildMe, renderWithProviders } from "@/test/utils"

import { BankingAdminPage } from "../BankingAdminPage"

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}))

function DondeEstoy(): React.JSX.Element {
  const { pathname, search } = useLocation()
  return <p data-testid="destino">{`${pathname}${search}`}</p>
}

function rutas(): React.JSX.Element {
  return (
    <Routes>
      <Route path="/admin/banco" element={<BankingAdminPage />} />
      <Route path="/admin/plata" element={<DondeEstoy />} />
    </Routes>
  )
}

describe("BankingAdminPage — las URLs viejas siguen andando", () => {
  it.each(["libro", "mano", "datafono", "plataformas"])("/admin/banco?tab=%s redirige a Plata con la misma pestaña", (tab) => {
    renderWithProviders(rutas(), {
      me: buildMe({ features: { "money.deposits": true, "money.bank": true } }),
      route: `/admin/banco?tab=${tab}&from=2026-10-01`,
    })
    expect(screen.getByTestId("destino")).toHaveTextContent(`/admin/plata?tab=${tab}&from=2026-10-01`)
  })

  it("las consignaciones se quedan en Caja", () => {
    renderWithProviders(rutas(), {
      me: buildMe({ features: { "money.deposits": true } }),
      route: "/admin/banco?tab=por-consignar",
    })
    expect(screen.queryByTestId("destino")).not.toBeInTheDocument()
    expect(screen.getByRole("tab", { name: "Por consignar", selected: true })).toBeInTheDocument()
  })
})
