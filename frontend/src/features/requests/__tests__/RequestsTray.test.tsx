/**
 * La bandeja del administrador y la lista de Compras: ajustar y aprobar
 * manda sólo lo ajustado; rechazar exige motivo; lo aprobado se marca
 * comprado. Los estados y cantidades vienen del servidor tal cual.
 */
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { StaffRequest } from "@/api/requests";
import { buildMe, renderWithProviders } from "@/test/utils";

import { ApprovedSuppliesPanel } from "../ApprovedSuppliesPanel";
import { RequestsTray } from "../RequestsTray";

const mocks = vi.hoisted(() => ({
  listAdminRequests: vi.fn(),
  listApprovedSupplyRequests: vi.fn(),
  approveRequest: vi.fn(),
  rejectRequest: vi.fn(),
  markRequestBought: vi.fn(),
}));

vi.mock("@/api/requests", async () => {
  const actual = await vi.importActual<typeof import("@/api/requests")>("@/api/requests");
  return { ...actual, ...mocks };
});

function request(overrides: Partial<StaffRequest>): StaffRequest {
  return {
    id: 1,
    kind: "supply",
    status: "pending",
    shift_id: 42,
    business_date: "2026-09-25",
    requested_by: { id: 3, name: "Cajera" },
    requested_at: "2026-09-25T15:00:00Z",
    note: "Para el fin de semana",
    reason: null,
    lines: [
      {
        id: 11,
        ingredient_id: 7,
        ingredient_name: "Leche",
        base_unit: "ml",
        qty_requested: "2400",
        qty_approved: null,
        suggested_qty: "2400",
        entry_unit: "L",
        qty_requested_entry: "2.4",
        qty_approved_entry: null,
      },
      {
        id: 12,
        ingredient_id: 9,
        ingredient_name: "Azúcar",
        base_unit: "g",
        qty_requested: "500",
        qty_approved: null,
        suggested_qty: null,
        entry_unit: "kg",
        qty_requested_entry: "0.5",
        qty_approved_entry: null,
      },
    ],
    requested_denominations: null,
    requested_total: null,
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

const ME = buildMe({ features: { "pos.requests": true } });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
});

describe("RequestsTray", () => {
  it("pide las pendientes de la sede y aprueba mandando sólo lo ajustado", async () => {
    const user = userEvent.setup();
    mocks.listAdminRequests.mockResolvedValue([request({})]);
    mocks.approveRequest.mockResolvedValue(request({ status: "approved" }));
    renderWithProviders(<RequestsTray storeId={5} />, { me: ME });

    const leche = await screen.findByLabelText("Cantidad aprobada de Leche");
    expect(mocks.listAdminRequests).toHaveBeenCalledWith(5, { status: "pending" });
    expect(leche).toHaveValue("2400");
    await user.clear(leche);
    await user.type(leche, "3000");
    await user.click(screen.getByRole("button", { name: "Aprobar" }));

    await waitFor(() => expect(mocks.approveRequest).toHaveBeenCalledTimes(1));
    expect(mocks.approveRequest).toHaveBeenCalledWith(1, { lines: [{ line_id: 11, qty: "3000" }] });
  });

  it("rechazar exige motivo", async () => {
    const user = userEvent.setup();
    mocks.listAdminRequests.mockResolvedValue([request({})]);
    mocks.rejectRequest.mockResolvedValue(request({ status: "rejected" }));
    renderWithProviders(<RequestsTray storeId={5} />, { me: ME });

    await user.click(await screen.findByRole("button", { name: "Rechazar" }));
    const confirmar = screen.getByRole("button", { name: "Confirmar rechazo" });
    expect(confirmar).toBeDisabled();
    await user.type(screen.getByLabelText("Motivo del rechazo"), "Hay en la bodega");
    await user.click(confirmar);
    await waitFor(() => expect(mocks.rejectRequest).toHaveBeenCalledWith(1, "Hay en la bodega"));
  });

  it("una sencilla se aprueba con el desglose que se va a llevar", async () => {
    const user = userEvent.setup();
    mocks.listAdminRequests.mockResolvedValue([
      request({
        id: 2,
        kind: "change",
        lines: [],
        note: null,
        reason: "Monedas",
        requested_denominations: [{ value: 1000, count: 10 }],
        requested_total: 10000,
      }),
    ]);
    mocks.approveRequest.mockResolvedValue(request({ id: 2, kind: "change", status: "approved" }));
    renderWithProviders(<RequestsTray storeId={5} />, { me: ME });

    const grupo = await screen.findByRole("group", { name: "Sencilla que vas a llevar" });
    const campos = within(grupo).getAllByRole("spinbutton");
    expect(campos[6]).toHaveValue(10);
    await user.clear(campos[6]!);
    await user.type(campos[6]!, "5");
    await user.click(screen.getByRole("button", { name: "Aprobar" }));

    await waitFor(() =>
      expect(mocks.approveRequest).toHaveBeenCalledWith(2, {
        denominations: { denominations: [{ value: 1000, count: 5 }], total: 5000 },
      }),
    );
  });

  it("sin pendientes lo dice", async () => {
    mocks.listAdminRequests.mockResolvedValue([]);
    renderWithProviders(<RequestsTray storeId={5} />, { me: ME });
    expect(await screen.findByText("No hay solicitudes pendientes.")).toBeInTheDocument();
  });
});

describe("ApprovedSuppliesPanel", () => {
  it("lista lo aprobado por comprar, sin los renglones en cero, y lo marca comprado", async () => {
    const user = userEvent.setup();
    const aprobada = request({
      status: "approved",
      resolved_at: "2026-09-25T16:00:00Z",
      lines: [
        { ...request({}).lines[0]!, qty_approved: "3000" },
        { ...request({}).lines[1]!, qty_approved: "0" },
      ],
    });
    mocks.listApprovedSupplyRequests.mockResolvedValue([aprobada]);
    mocks.markRequestBought.mockResolvedValue({ ...aprobada, status: "bought" });
    renderWithProviders(<ApprovedSuppliesPanel storeId={5} />, { me: ME });

    expect(await screen.findByText(/Leche/)).toBeInTheDocument();
    expect(screen.queryByText(/Azúcar/)).not.toBeInTheDocument();
    expect(mocks.listApprovedSupplyRequests).toHaveBeenCalledWith(5);
    await user.click(screen.getByRole("button", { name: "Marcar comprado" }));
    await waitFor(() => expect(mocks.markRequestBought).toHaveBeenCalledWith(1));
  });
});
