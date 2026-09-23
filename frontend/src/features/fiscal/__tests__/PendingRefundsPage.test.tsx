import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { PendingRefundsPage } from "../PendingRefundsPage";

vi.mock("@/app/storeContext", () => ({
  useStoreSelection: () => ({ stores: [{ id: 1, name: "Sede Centro" }], loading: false, activeStoreId: 1, setActiveStoreId: vi.fn() }),
}));

const { listPendingRefundsMock, settlePendingRefundMock, listAdminShiftsMock } = vi.hoisted(() => ({
  listPendingRefundsMock: vi.fn(),
  settlePendingRefundMock: vi.fn(),
  listAdminShiftsMock: vi.fn(),
}));

vi.mock("@/api/fiscal", async () => {
  const actual = await vi.importActual<typeof import("@/api/fiscal")>("@/api/fiscal");
  return { ...actual, listPendingRefunds: listPendingRefundsMock, settlePendingRefund: settlePendingRefundMock };
});

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, listAdminShifts: listAdminShiftsMock };
});

const PENDING_ROW = {
  id: 1,
  store_id: 1,
  document_id: 900,
  customer_id: null,
  customer_name: "Consumidor final",
  customer_doc_number: "222222222222",
  amount: 12000,
  method: "cash",
  authorized_by_employee_id: 7,
  authorized_by_employee_name: "Ana",
  requested_at: "2026-09-15T19:00:00Z",
  status: "pending" as const,
};

describe("PendingRefundsPage", () => {
  it("saldar desde el turno abierto manda el shift_id de ESE turno", async () => {
    listPendingRefundsMock.mockResolvedValue([PENDING_ROW]);
    listAdminShiftsMock.mockResolvedValue([{ id: 55, status: "open" }]);
    settlePendingRefundMock.mockResolvedValue({ ...PENDING_ROW, status: "settled" });
    const user = userEvent.setup();

    renderWithProviders(<PendingRefundsPage />);

    await waitFor(() => expect(screen.getByText("#900")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Saldar" }));

    await waitFor(() => expect(listAdminShiftsMock).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: /^Devolver \$\s?12\.000$/ }));

    await waitFor(() => expect(settlePendingRefundMock).toHaveBeenCalledTimes(1));
    const [pendingRefundId, body] = settlePendingRefundMock.mock.calls[0];
    expect(pendingRefundId).toBe(1);
    expect(body).toEqual({ from: "shift", shift_id: 55 });
  });

  it("sin turno abierto, avisa y no deja confirmar «desde el turno»", async () => {
    listPendingRefundsMock.mockResolvedValue([PENDING_ROW]);
    listAdminShiftsMock.mockResolvedValue([]);
    const user = userEvent.setup();

    renderWithProviders(<PendingRefundsPage />);

    await waitFor(() => expect(screen.getByText("#900")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Saldar" }));

    await waitFor(() => expect(listAdminShiftsMock).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(/no hay ningún turno abierto/i);
    expect(screen.getByRole("button", { name: /^Devolver \$\s?12\.000$/ })).toBeDisabled();
  });
});
