import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { MemoryRouter } from "react-router-dom"

import { OpenCountDialog } from "../OpenCountDialog"

const { postOpenCountMock } = vi.hoisted(() => ({ postOpenCountMock: vi.fn() }))

vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory")
  return { ...actual, postOpenCount: postOpenCountMock }
})

function renderDialog(onOpened = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return {
    onOpened,
    ...render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <OpenCountDialog storeId={1} onOpened={onOpened} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}

describe("OpenCountDialog — abrir un conteo (SPEC-NEGOCIO §5.4)", () => {
  it("por defecto abre en «Críticos» y manda el alcance elegido", async () => {
    postOpenCountMock.mockResolvedValue({
      id: 42,
      scope: "full",
      status: "open",
      opened_at: "2026-09-16T10:00:00Z",
      business_date: "2026-09-16",
      opened_by_employee_id: 1,
      opened_by_employee_name: "Ana",
      applied_at: null,
      applied_by_employee_id: null,
      applied_by_employee_name: null,
      lines_total: 20,
      lines_counted: 0,
      lines: [],
    })

    const user = userEvent.setup()
    const { onOpened } = renderDialog()

    await user.click(screen.getByRole("button", { name: "Abrir conteo" }))
    await screen.findByRole("dialog")

    await user.click(screen.getByRole("combobox", { name: "Alcance" }))
    await user.click(await screen.findByRole("option", { name: "Completo" }))

    await user.click(screen.getByRole("button", { name: "Abrir conteo" }))

    await waitFor(() => expect(postOpenCountMock).toHaveBeenCalledWith(1, "full"))
    await waitFor(() => expect(onOpened).toHaveBeenCalledWith(42))
  })
})
