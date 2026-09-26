import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReserveStatus } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { ReturnToReservePanel, TakeFromReservePanel } from "..";

const { getReserveMock, returnMock } = vi.hoisted(() => ({ getReserveMock: vi.fn(), returnMock: vi.fn() }));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return { ...actual, getShiftReserve: getReserveMock, returnToReserve: returnMock };
});

beforeEach(() => {
  getReserveMock.mockReset();
  returnMock.mockReset();
});

const STATUS: ReserveStatus = {
  enabled: true,
  configured: true,
  amount: 200_000,
  available: 130_000,
  loan: 70_000,
  movements: [],
  can_verify: false,
};

describe("Base de respaldo — los paneles que cuelga la cinta de Mesas", () => {
  it("«Tomar de la base» muestra lo disponible que dice el servidor y pide PIN de supervisor", async () => {
    getReserveMock.mockResolvedValue(STATUS);
    const user = userEvent.setup();
    renderWithProviders(<TakeFromReservePanel shiftId={3} />);

    expect(await screen.findByText("$ 130.000")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Monto a tomar"), "50000");
    expect(await screen.findByText(/PIN de supervisor o administrador/)).toBeInTheDocument();
  });

  it("«Devolver a la base» manda lo que el servidor dice que se debe y avisa con onDone", async () => {
    getReserveMock.mockResolvedValue(STATUS);
    returnMock.mockResolvedValue({ id: 1, kind: "return", amount: 70_000 });
    const onDone = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<ReturnToReservePanel shiftId={3} onDone={onDone} />);

    await user.click(await screen.findByRole("button", { name: "Devolver $ 70.000 a la base" }));
    await waitFor(() => expect(returnMock).toHaveBeenCalledTimes(1));
    expect(returnMock.mock.calls[0]?.[0]).toBe(3);
    expect(returnMock.mock.calls[0]?.[1]).toMatchObject({ amount: 70_000 });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("sin préstamo no hay nada que devolver", async () => {
    getReserveMock.mockResolvedValue({ ...STATUS, loan: 0 });
    renderWithProviders(<ReturnToReservePanel shiftId={3} />);
    expect(await screen.findByText("El cajón no le debe nada a la base")).toBeInTheDocument();
  });
});
