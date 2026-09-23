import { screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { KdsPage } from "../KdsPage"
import { buildKdsRound, buildPrintJob, deviceMe } from "./fixtures"

const {
  listKitchenRoundsMock,
  listPrintJobsMock,
  bumpItemMock,
  unbumpItemMock,
  expediteOrderMock,
  registerPrintJobMock,
} = vi.hoisted(() => ({
  listKitchenRoundsMock: vi.fn(),
  listPrintJobsMock: vi.fn(),
  bumpItemMock: vi.fn(),
  unbumpItemMock: vi.fn(),
  expediteOrderMock: vi.fn(),
  registerPrintJobMock: vi.fn(),
}))

vi.mock("@/api/kitchen", async () => {
  const actual = await vi.importActual<typeof import("@/api/kitchen")>("@/api/kitchen")
  return {
    ...actual,
    listKitchenRounds: listKitchenRoundsMock,
    listPrintJobs: listPrintJobsMock,
    bumpItem: bumpItemMock,
    unbumpItem: unbumpItemMock,
    expediteOrder: expediteOrderMock,
    registerPrintJob: registerPrintJobMock,
  }
})

describe("KdsPage", () => {
  it("sin kitchen.kds muestra el mensaje de función apagada y no pide datos", () => {
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": false }) })

    expect(screen.getByText(/el kds no está habilitado/i)).toBeInTheDocument()
    expect(listKitchenRoundsMock).not.toHaveBeenCalled()
  })

  it("pinta la ronda, respeta el semáforo tal cual llega, y bumpea con Idempotency-Key nueva por click", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])
    bumpItemMock.mockResolvedValue({
      item_id: 101,
      order_id: 501,
      status: "ready",
      ready_at: "2026-09-19T18:03:00Z",
      changed: true,
      bumped_by: { id: 7, name: "Ana" },
      bumped_at: "2026-09-19T18:03:00Z",
    })

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    expect(screen.getByText(/a tiempo/i)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /marcar listo: bandeja paisa/i }))

    await waitFor(() => expect(bumpItemMock).toHaveBeenCalledWith(101))
  })

  it("bumpear dos veces (idempotente en el servidor) no rompe la pantalla: el segundo click también resuelve sin error", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])
    bumpItemMock.mockResolvedValue({
      item_id: 101,
      order_id: 501,
      status: "ready",
      ready_at: "2026-09-19T18:03:00Z",
      changed: false,
      bumped_by: { id: 7, name: "Ana" },
      bumped_at: "2026-09-19T18:03:00Z",
    })

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /marcar listo: bandeja paisa/i }))

    await waitFor(() => expect(bumpItemMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("muestra «Deshacer» sobre un ítem ready, y deshacer llama unbumpItem", async () => {
    listKitchenRoundsMock.mockResolvedValue([
      buildKdsRound({
        items: [
          {
            item_id: 101,
            name: "Bandeja Paisa",
            qty: 1,
            modifiers_text: null,
            note: null,
            course: "main",
            station: "hot_kitchen",
            status: "ready",
            elapsed_seconds: 120,
            target_minutes: 18,
            semaphore: "green",
            course_fired_at: null,
            bumped_by: { id: 7, name: "Ana" },
            bumped_at: "2026-09-19T18:03:00Z",
          },
        ],
      }),
    ])
    listPrintJobsMock.mockResolvedValue([])
    unbumpItemMock.mockResolvedValue({
      item_id: 101,
      order_id: 501,
      status: "sent",
      ready_at: null,
      changed: true,
      bumped_by: null,
      bumped_at: null,
    })

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/lo marcó listo ana/i)).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /deshacer listo: bandeja paisa/i }))

    await waitFor(() => expect(unbumpItemMock).toHaveBeenCalledWith(101))
  })

  it("«Expedir comanda» llama a expediteOrder con el order_id, no con el ítem", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])
    expediteOrderMock.mockResolvedValue({
      order_id: 501,
      changed: true,
      changed_item_ids: [101],
      items: [],
      expedited_by: { id: 7, name: "Ana" },
      expedited_at: "2026-09-19T18:05:00Z",
    })

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /expedir comanda completa #501/i }))

    await waitFor(() => expect(expediteOrderMock).toHaveBeenCalledWith(501))
  })

  it("muestra el canal plataforma tal cual lo manda el servidor (source · external_id), sin comisión en pantalla", async () => {
    listKitchenRoundsMock.mockResolvedValue([
      buildKdsRound({ channel: "platform", tables: [], platform: { source: "Rappi", external_id: "RAPPI-9001" } }),
    ])
    listPrintJobsMock.mockResolvedValue([])

    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/rappi · rappi-9001/i)).toBeInTheDocument())
    expect(screen.queryByText(/comisi[oó]n/i)).not.toBeInTheDocument()
  })

  it("pestaña Impresión: confirmar registra el trabajo (no simula una impresora real)", async () => {
    listKitchenRoundsMock.mockResolvedValue([])
    listPrintJobsMock.mockResolvedValue([buildPrintJob()])
    registerPrintJobMock.mockResolvedValue(buildPrintJob({ printed: true, print_count: 1 }))

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await user.click(screen.getByRole("tab", { name: /impresión por estación/i }))
    await waitFor(() => expect(screen.getByText(/sin registrar/i)).toBeInTheDocument())
    expect(screen.getByText(/no envía nada a una impresora física/i)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /confirmar impresión/i }))

    await waitFor(() =>
      expect(registerPrintJobMock).toHaveBeenCalledWith({ round_id: 17, station: "hot_kitchen" }),
    )
  })

  it("no navega a ninguna otra pantalla (no hay enlaces)", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])

    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    expect(screen.queryAllByRole("link")).toHaveLength(0)
  })
})
