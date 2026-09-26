/**
 * El panel de solicitudes del POS. Lo que se prueba es lo que no se negocia:
 *
 * - arranca vacío (buscador y frecuentes arriba); los sugeridos del área van
 *   plegados y entran con la cantidad que redondea el SERVIDOR, tal cual;
 * - el POST de insumos lleva las cantidades como texto en la unidad cómoda,
 *   con su `entry_unit`: el servidor convierte;
 * - la sencilla exige motivo y viaja por denominaciones;
 * - el estado de cada solicitud lo dice el servidor, y una sencilla aprobada
 *   se registra con el Cambio que ya existe (precargado con lo aprobado) y
 *   recién ahí se marca recibida, atada a ese Cambio.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StaffRequest, SupplySuggestions } from "@/api/requests";
import { buildMe, renderWithProviders } from "@/test/utils";

import { RequestsPanel } from "../RequestsPanel";

const mocks = vi.hoisted(() => ({
  getSupplySuggestions: vi.fn(),
  listMyRequests: vi.fn(),
  createSupplyRequest: vi.fn(),
  createChangeRequest: vi.fn(),
  markChangeReceived: vi.fn(),
  listDeviceIngredients: vi.fn(),
  createCashSwap: vi.fn(),
}));

vi.mock("@/api/requests", async () => {
  const actual = await vi.importActual<typeof import("@/api/requests")>("@/api/requests");
  return {
    ...actual,
    getSupplySuggestions: mocks.getSupplySuggestions,
    listMyRequests: mocks.listMyRequests,
    createSupplyRequest: mocks.createSupplyRequest,
    createChangeRequest: mocks.createChangeRequest,
    markChangeReceived: mocks.markChangeReceived,
  };
});
vi.mock("@/api/inventory", async () => {
  const actual = await vi.importActual<typeof import("@/api/inventory")>("@/api/inventory");
  return { ...actual, listDeviceIngredients: mocks.listDeviceIngredients };
});
vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, createCashSwap: mocks.createCashSwap };
});

const SUGGESTIONS: SupplySuggestions = {
  available: true,
  reason: null,
  area_name: "Bar",
  area_via: "member",
  other_areas_count: 40,
  frequent: [{ ingredient_id: 9, name: "Azúcar", entry_mode: "weight", entry_unit: "kg" }],
  rows: [
    {
      ingredient_id: 7,
      name: "Leche",
      base_unit: "ml",
      current_stock: "-400",
      min_stock: "2000",
      negative: true,
      suggested_qty: "3000",
      entry_mode: "volume",
      entry_unit: "L",
      suggested_entry_qty: "3",
    },
  ],
};

function request(overrides: Partial<StaffRequest>): StaffRequest {
  return {
    id: 1,
    kind: "change",
    status: "pending",
    shift_id: 42,
    business_date: "2026-09-25",
    requested_by: { id: 3, name: "Cajera" },
    requested_at: "2026-09-25T15:00:00Z",
    note: null,
    reason: "Monedas",
    lines: [],
    requested_denominations: [{ value: 1000, count: 10 }],
    requested_total: 10000,
    approved_denominations: null,
    approved_total: null,
    resolved_by: null,
    resolved_at: null,
    resolution_note: null,
    closed_by: null,
    closed_at: null,
    cash_swap_id: null,
    ...overrides,
  };
}

const ME = buildMe({
  kind: "device",
  features: { "pos.requests": true, "inventory.perpetual": true, "cash.swaps": true },
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.getSupplySuggestions.mockResolvedValue(SUGGESTIONS);
  mocks.listDeviceIngredients.mockResolvedValue([
    { id: 7, name: "Leche", base_unit: "ml", entry_mode: "volume", entry_unit: "L" },
    { id: 9, name: "Azúcar", base_unit: "g", entry_mode: "weight", entry_unit: "kg" },
    { id: 11, name: "Huevo", base_unit: "unit", entry_mode: "unit", entry_unit: "unidad" },
  ]);
  mocks.listMyRequests.mockResolvedValue([]);
});

describe("RequestsPanel", () => {
  it("arranca vacío: los sugeridos del área van plegados y no entran solos al pedido", async () => {
    renderWithProviders(<RequestsPanel shiftId={42} />, { me: ME });

    const sugeridos = await screen.findByRole("button", { name: /Sugeridos \(1\) de Bar/ });
    expect(sugeridos).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Cantidad de Leche")).not.toBeInTheDocument();
    expect(screen.getByText(/Todavía no hay insumos/)).toBeInTheDocument();
    // Otras áreas: se dice cuántos, no se listan.
    expect(screen.getByText(/Otras áreas tienen 40 insumos bajo mínimo/)).toBeInTheDocument();
  });

  it("«Agregar todos» trae la cantidad sugerida del servidor en la unidad cómoda y la manda con su unidad", async () => {
    const user = userEvent.setup();
    mocks.createSupplyRequest.mockResolvedValue(request({ kind: "supply" }));
    renderWithProviders(<RequestsPanel shiftId={42} />, { me: ME });

    await user.click(await screen.findByRole("button", { name: "Agregar todos" }));
    expect(screen.getByLabelText("Cantidad de Leche")).toHaveValue("3");
    expect(screen.getByText("En negativo")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Enviar pedido" }));

    await waitFor(() => expect(mocks.createSupplyRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createSupplyRequest).toHaveBeenCalledWith({
      lines: [{ ingredient_id: 7, qty: "3", entry_unit: "L" }],
      note: null,
    });
  });

  it("pedir dos insumos: un frecuente y uno buscado, en su unidad cómoda («unidades», nunca «unit»)", async () => {
    const user = userEvent.setup();
    mocks.createSupplyRequest.mockResolvedValue(request({ kind: "supply" }));
    renderWithProviders(<RequestsPanel shiftId={42} />, { me: ME });

    await user.click(await screen.findByRole("button", { name: "Azúcar" }));
    await user.type(screen.getByLabelText("Cantidad de Azúcar"), "2,5");
    await user.type(screen.getByLabelText("Buscar insumo"), "hue");
    await user.click(await screen.findByRole("button", { name: "+ Huevo (unidades)" }));
    await user.type(screen.getByLabelText("Cantidad de Huevo"), "30");
    expect(screen.queryByText(/\bunit\b/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Nota (opcional)"), "Para el fin de semana");
    await user.click(screen.getByRole("button", { name: "Enviar pedido" }));

    await waitFor(() => expect(mocks.createSupplyRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createSupplyRequest).toHaveBeenCalledWith({
      lines: [
        { ingredient_id: 9, qty: "2,5", entry_unit: "kg" },
        { ingredient_id: 11, qty: "30", entry_unit: "unidad" },
      ],
      note: "Para el fin de semana",
    });
  });

  it("la sencilla exige motivo y viaja por denominaciones", async () => {
    const user = userEvent.setup();
    mocks.createChangeRequest.mockResolvedValue(request({}));
    renderWithProviders(<RequestsPanel shiftId={42} />, { me: ME });

    await user.click(await screen.findByRole("tab", { name: "Sencilla" }));
    const pedir = await screen.findByRole("button", { name: "Pedir sencilla" });
    expect(pedir).toBeDisabled();

    // Billetes de mayor a menor y después monedas: la séptima es la de $1.000.
    const campos = within(screen.getByRole("group", { name: "Sencilla que necesitás" })).getAllByRole("spinbutton");
    await user.type(campos[6]!, "10");
    expect(pedir).toBeDisabled();
    await user.type(screen.getByLabelText("Motivo"), "Se acabaron las monedas");
    await user.click(pedir);

    await waitFor(() => expect(mocks.createChangeRequest).toHaveBeenCalledTimes(1));
    expect(mocks.createChangeRequest).toHaveBeenCalledWith({
      denominations: { denominations: [{ value: 1000, count: 10 }], total: 10000 },
      reason: "Se acabaron las monedas",
    });
  });

  it("muestra el estado que dice el servidor, con el motivo del rechazo", async () => {
    mocks.listMyRequests.mockResolvedValue([
      request({ id: 1, kind: "supply", status: "approved", lines: [] }),
      request({ id: 2, status: "rejected", resolution_note: "Hay en la caja fuerte" }),
    ]);
    renderWithProviders(<RequestsPanel shiftId={42} />, { me: ME });

    expect(await screen.findByText("Aprobado · por comprar")).toBeInTheDocument();
    expect(screen.getByText("Rechazado")).toBeInTheDocument();
    expect(screen.getByText("Motivo: Hay en la caja fuerte")).toBeInTheDocument();
  });

  it("una sencilla aprobada se registra con el Cambio precargado y después se marca recibida", async () => {
    const user = userEvent.setup();
    const aprobada = request({
      id: 5,
      status: "approved",
      approved_denominations: [{ value: 1000, count: 10 }],
      approved_total: 10000,
    });
    mocks.listMyRequests.mockResolvedValue([aprobada]);
    mocks.createCashSwap.mockResolvedValue({ id: 88 });
    mocks.markChangeReceived.mockResolvedValue({ ...aprobada, status: "received", cash_swap_id: 88 });
    renderWithProviders(<RequestsPanel shiftId={42} />, { me: ME });

    expect(await screen.findByText("Aprobado · por entregar")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Llegó la sencilla" }));
    // Lo que sale lo cuenta quien tiene la caja: un billete de $10.000.
    const sale = within(screen.getByRole("group", { name: "Sale (se entrega)" })).getAllByRole("spinbutton");
    // 100.000, 50.000, 20.000, 10.000: el cuarto.
    await user.type(sale[3]!, "1");
    // «Entra» viene precargado con lo aprobado.
    const entra = within(screen.getByRole("group", { name: "Entra (se recibe)" })).getAllByRole("spinbutton");
    expect(entra[6]).toHaveValue(10);
    await user.click(screen.getByRole("button", { name: "Registrar cambio y marcar recibida" }));

    await waitFor(() => expect(mocks.markChangeReceived).toHaveBeenCalledWith(5, 88));
    expect(mocks.createCashSwap).toHaveBeenCalledWith(42, {
      out: { denominations: [{ value: 10000, count: 1 }], total: 10000 },
      in: { denominations: [{ value: 1000, count: 10 }], total: 10000 },
    });
  });

  it("sin inventario no ofrece la pestaña de insumos", async () => {
    renderWithProviders(<RequestsPanel shiftId={42} />, {
      me: buildMe({ kind: "device", features: { "pos.requests": true, "cash.swaps": true } }),
    });
    expect(await screen.findByRole("tab", { name: "Sencilla" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Insumos" })).not.toBeInTheDocument();
    expect(mocks.getSupplySuggestions).not.toHaveBeenCalled();
  });
});
