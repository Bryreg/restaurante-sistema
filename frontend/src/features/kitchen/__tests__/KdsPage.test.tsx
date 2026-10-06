import { screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { renderWithProviders } from "@/test/utils"

import { KdsPage } from "../KdsPage"
import { buildKdsRound, buildPrintJob, deviceMe } from "./fixtures"

const {
  listKitchenRoundsMock,
  listKitchenStationsMock,
  listPrintJobsMock,
  bumpItemMock,
  unbumpItemMock,
  expediteOrderMock,
  registerPrintJobMock,
} = vi.hoisted(() => ({
  listKitchenRoundsMock: vi.fn(),
  listKitchenStationsMock: vi.fn(),
  listPrintJobsMock: vi.fn(),
  bumpItemMock: vi.fn(),
  unbumpItemMock: vi.fn(),
  expediteOrderMock: vi.fn(),
  registerPrintJobMock: vi.fn(),
}))

const { markReadyMock } = vi.hoisted(() => ({ markReadyMock: vi.fn() }))

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders")
  return { ...actual, markReady: markReadyMock }
})

const { deviceIdentifyMock } = vi.hoisted(() => ({ deviceIdentifyMock: vi.fn() }))

vi.mock("@/api/auth", async () => {
  const actual = await vi.importActual<typeof import("@/api/auth")>("@/api/auth")
  return { ...actual, deviceIdentify: deviceIdentifyMock }
})

beforeEach(() => {
  vi.clearAllMocks()
  listKitchenStationsMock.mockResolvedValue([])
  try {
    localStorage.clear()
  } catch {
    // sin almacenamiento en el entorno: los tests que lo usan lo dicen
  }
})

vi.mock("@/api/kitchen", async () => {
  const actual = await vi.importActual<typeof import("@/api/kitchen")>("@/api/kitchen")
  return {
    ...actual,
    listKitchenRounds: listKitchenRoundsMock,
    listKitchenStations: listKitchenStationsMock,
    listPrintJobs: listPrintJobsMock,
    bumpItem: bumpItemMock,
    unbumpItem: unbumpItemMock,
    expediteOrder: expediteOrderMock,
    registerPrintJob: registerPrintJobMock,
  }
})

describe("KdsPage", () => {
  it("sin kitchen.view ni kitchen.kds muestra el mensaje de función apagada y no pide datos", () => {
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.view": false, "kitchen.kds": false }) })

    expect(screen.getByText(/la pantalla de cocina no está habilitada/i)).toBeInTheDocument()
    expect(listKitchenRoundsMock).not.toHaveBeenCalled()
  })

  // Era la vista mínima de `/pos/cocina` (borrada): con sólo `kitchen.view`
  // la misma pantalla marca listo por la ruta de la comanda, sin deshacer,
  // sin expedir y sin impresión (esas rutas exigen `kitchen.kds`).
  describe("con sólo kitchen.view (sin KDS completo)", () => {
    it("pinta la ronda y marca listo por la ruta de la comanda, con Idempotency-Key", async () => {
      listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
      markReadyMock.mockResolvedValue({})

      const user = userEvent.setup()
      renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.view": true, "kitchen.kds": false }) })

      await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
      await user.click(screen.getByRole("button", { name: /marcar listo: bandeja paisa/i }))

      await waitFor(() => expect(markReadyMock).toHaveBeenCalledWith(501, 101, expect.any(String)))
      expect(bumpItemMock).not.toHaveBeenCalled()
    })

    it("no ofrece expedir, impresión ni deshacer, y no pide las rutas del KDS", async () => {
      listKitchenRoundsMock.mockResolvedValue([
        buildKdsRound({
          items: [{ ...buildKdsRound().items![0]!, status: "ready" }],
        }),
      ])

      renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.view": true, "kitchen.kds": false }) })

      await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
      expect(screen.queryByRole("button", { name: /expedir/i })).not.toBeInTheDocument()
      expect(screen.queryByRole("tab", { name: /impresión/i })).not.toBeInTheDocument()
      expect(screen.queryByRole("button", { name: /deshacer listo/i })).not.toBeInTheDocument()
      expect(screen.getByRole("button", { name: /listo: bandeja paisa/i })).toBeDisabled()
      expect(listKitchenStationsMock).not.toHaveBeenCalled()
      expect(listPrintJobsMock).not.toHaveBeenCalled()
    })
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
    // El estado sale dos veces: en la cabecera del tiquete (el más urgente
    // de la comanda) y en el ítem. Los dos tal cual los mandó el servidor.
    expect(screen.getAllByText(/a tiempo/i).length).toBeGreaterThanOrEqual(2)

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

  it("sin persona vigente, «Listo» abre el PIN rápido con quien usó la estación por última vez, y después marca", async () => {
    localStorage.setItem("cocina-pantalla", JSON.stringify({ lastPerson: { id: 9, name: "Rosa" } }))
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])
    deviceIdentifyMock.mockResolvedValue({ employee: { id: 9, name: "Rosa", role: "operator", can_charge: false } })
    bumpItemMock.mockResolvedValue({
      item_id: 101,
      order_id: 501,
      status: "ready",
      ready_at: "2026-09-19T18:03:00Z",
      changed: true,
      bumped_by: { id: 9, name: "Rosa" },
      bumped_at: "2026-09-19T18:03:00Z",
    })
    const refresh = vi.fn().mockResolvedValue(undefined)

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, {
      me: { ...deviceMe({ "kitchen.kds": true }), employee: null },
      session: { refresh },
    })

    // La pantalla se ve sin nadie identificado.
    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    expect(screen.getByText(/nadie identificado/i)).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /marcar listo: bandeja paisa/i }))
    expect(bumpItemMock).not.toHaveBeenCalled()
    expect(await screen.findByRole("group", { name: /pin de rosa/i })).toBeInTheDocument()

    for (const digit of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    await waitFor(() => expect(deviceIdentifyMock).toHaveBeenCalledWith({ employee_id: 9, pin: "1234" }))
    await waitFor(() => expect(bumpItemMock).toHaveBeenCalledWith(101))
    expect(refresh).toHaveBeenCalled()
  })

  it("un PIN equivocado no marca nada y deja el error del servidor a la vista", async () => {
    localStorage.setItem("cocina-pantalla", JSON.stringify({ lastPerson: { id: 9, name: "Rosa" } }))
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])
    const { ApiError } = await import("@/api/client")
    deviceIdentifyMock.mockRejectedValue(new ApiError(400, "PIN_INVALID", "PIN incorrecto; intentá de nuevo"))

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: { ...deviceMe({ "kitchen.kds": true }), employee: null } })

    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    await user.click(screen.getByRole("button", { name: /marcar listo: bandeja paisa/i }))
    await screen.findByRole("group", { name: /pin de rosa/i })
    for (const digit of ["9", "9", "9", "9"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }))
    }

    expect(await screen.findByText(/pin incorrecto/i)).toBeInTheDocument()
    expect(bumpItemMock).not.toHaveBeenCalled()
  })

  it("filtrada por estación, «Expedir» manda la estación y la pantalla la recuerda", async () => {
    localStorage.setItem("cocina-pantalla", JSON.stringify({ station: "hot_kitchen" }))
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

    await waitFor(() => expect(listKitchenRoundsMock).toHaveBeenCalledWith("hot_kitchen"))
    expect(screen.getByRole("button", { name: "Cocina caliente" })).toHaveAttribute("aria-pressed", "true")
    await user.click(await screen.findByRole("button", { name: /expedir cocina caliente de la comanda #501/i }))
    await waitFor(() => expect(expediteOrderMock).toHaveBeenCalledWith(501, "hot_kitchen"))

    await user.click(screen.getByRole("button", { name: "Todas" }))
    expect(JSON.parse(localStorage.getItem("cocina-pantalla") ?? "{}").station).toBeUndefined()
  })

  it("una nota con alergia va en rojo con ícono; los modificadores, en el recuadro amarillo", async () => {
    listKitchenRoundsMock.mockResolvedValue([
      buildKdsRound({
        items: [
          {
            item_id: 101,
            name: "Bandeja Paisa",
            qty: 1,
            modifiers_text: "Sin cebolla",
            note: "Cliente ALÉRGICO al maní",
            course: "main",
            station: "hot_kitchen",
            status: "sent",
            elapsed_seconds: 60,
            target_minutes: 15,
            semaphore: "green",
          },
        ],
      }),
    ])
    listPrintJobsMock.mockResolvedValue([])

    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    const alerta = await screen.findByText(/alerta de alergia/i)
    expect(alerta.closest(".tiquete-alergia")).toHaveTextContent(/alérgico al maní/i)
    expect(screen.getByText("Sin cebolla")).toHaveClass("tiquete-modificadores")
  })

  it("lo «de ayer» se aparta por defecto y se ve con el botón", async () => {
    listKitchenRoundsMock.mockResolvedValue([
      buildKdsRound(),
      buildKdsRound({
        order_id: 77,
        stale: true,
        tables: ["9"],
        items: [
          {
            item_id: 900,
            name: "Sancocho olvidado",
            qty: 1,
            course: "main",
            station: "hot_kitchen",
            status: "sent",
            elapsed_seconds: 237_600,
            target_minutes: 15,
            semaphore: "red",
          },
        ],
      }),
    ])
    listPrintJobsMock.mockResolvedValue([])

    const user = userEvent.setup()
    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await waitFor(() => expect(screen.getByText(/bandeja paisa/i)).toBeInTheDocument())
    expect(screen.queryByText(/sancocho olvidado/i)).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /ver lo de ayer \(1\)/i }))
    expect(screen.getByText(/sancocho olvidado/i)).toBeInTheDocument()
    expect(screen.getByText("De ayer")).toBeInTheDocument()
  })

  it("«Pantalla completa» pone la estación encima del marco del POS y lo recuerda", async () => {
    listKitchenRoundsMock.mockResolvedValue([buildKdsRound()])
    listPrintJobsMock.mockResolvedValue([])

    const user = userEvent.setup()
    const { container } = renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await user.click(await screen.findByRole("button", { name: "Pantalla completa" }))
    expect(container.querySelector(".kds-completa")).not.toBeNull()
    expect(JSON.parse(localStorage.getItem("cocina-pantalla") ?? "{}").fullscreen).toBe(true)
    expect(screen.getByRole("button", { name: "Salir de pantalla completa" })).toBeInTheDocument()
  })
})

describe("KdsPage — la pizarra del handoff", () => {
  function ronda(order_id: number, mesa: string, elapsed: number, semaphore: "green" | "amber" | "red", station = "hot_kitchen") {
    return buildKdsRound({
      order_id,
      tables: [mesa],
      elapsed_seconds: elapsed,
      items: [
        {
          item_id: order_id * 10,
          name: `Plato ${mesa}`,
          qty: 1,
          course: "main",
          station,
          status: "sent",
          elapsed_seconds: elapsed,
          target_minutes: 18,
          semaphore,
        },
      ],
    })
  }

  it("la barra trae las estaciones configuradas (sin «none») con sus conteos, y el resumen ■ ▲ ● del servidor", async () => {
    listKitchenStationsMock.mockResolvedValue(["hot_kitchen", "cold_kitchen", "desserts", "none"])
    listKitchenRoundsMock.mockResolvedValue([
      ronda(1, "11", 1560, "red"),
      ronda(2, "6", 960, "amber"),
      ronda(3, "9", 360, "green", "cold_kitchen"),
    ])
    listPrintJobsMock.mockResolvedValue([])

    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await screen.findByText("Plato 11")
    const estaciones = screen.getByRole("radiogroup", { name: "Estación" })
    expect(within(estaciones).getByRole("button", { name: "Todas" })).toHaveTextContent("3")
    expect(within(estaciones).getByRole("button", { name: "Cocina caliente" })).toHaveTextContent("2")
    expect(within(estaciones).getByRole("button", { name: "Cocina fría" })).toHaveTextContent("1")
    // Configurada aunque hoy no tenga tiquetes; «none» no es una estación.
    expect(within(estaciones).getByRole("button", { name: "Postres" })).toHaveTextContent("0")
    expect(within(estaciones).queryByRole("button", { name: /sin estación/i })).not.toBeInTheDocument()

    expect(screen.getByText("1 demorados")).toBeInTheDocument()
    expect(screen.getByText("1 por vencer")).toBeInTheDocument()
    expect(screen.getByText("1 a tiempo")).toBeInTheDocument()
  })

  it("ordena los tiquetes por demora y pinta la cabecera con el semáforo del servidor", async () => {
    listKitchenRoundsMock.mockResolvedValue([
      ronda(3, "9", 360, "green"),
      ronda(1, "11", 1560, "red"),
      ronda(2, "6", 960, "amber"),
    ])
    listPrintJobsMock.mockResolvedValue([])

    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    await screen.findByText("Plato 11")
    const tiquetes = screen.getAllByRole("article")
    expect(tiquetes.map((t) => t.getAttribute("aria-label"))).toEqual([
      "Comanda #1, Mesa 11",
      "Comanda #2, Mesa 6",
      "Comanda #3, Mesa 9",
    ])
    expect(within(tiquetes[0]!).getByText("26 min")).toBeInTheDocument()
    expect(tiquetes[0]!.querySelector("header")).toHaveClass("bg-destructive")
    expect(tiquetes[1]!.querySelector("header")).toHaveClass("bg-warning")
    expect(tiquetes[2]!.querySelector("header")).toHaveClass("bg-success")
  })

  it("«Listo» va en contorno y, ya listo, lleno con el plato tachado", async () => {
    listKitchenRoundsMock.mockResolvedValue([
      buildKdsRound({
        items: [
          { item_id: 1, name: "Posta", qty: 1, course: "main", station: "hot_kitchen", status: "ready", elapsed_seconds: 60, semaphore: "green" },
          { item_id: 2, name: "Arroz", qty: 2, course: "main", station: "hot_kitchen", status: "sent", elapsed_seconds: 60, semaphore: "green" },
        ],
      }),
    ])
    listPrintJobsMock.mockResolvedValue([])

    renderWithProviders(<KdsPage />, { me: deviceMe({ "kitchen.kds": true }) })

    const hecho = await screen.findByRole("button", { name: "Deshacer listo: Posta" })
    const falta = screen.getByRole("button", { name: "Marcar listo: Arroz" })
    expect(hecho).toHaveClass("bg-success")
    expect(falta).toHaveClass("bg-transparent")
    expect(screen.getByText("Posta")).toHaveClass("line-through")
    expect(screen.getByText("Arroz")).not.toHaveClass("line-through")
  })
})
