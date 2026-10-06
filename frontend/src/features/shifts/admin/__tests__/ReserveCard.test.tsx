import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminReserve } from "@/api/shifts";
import { buildMe, renderWithProviders } from "@/test/utils";

import { ReserveCard } from "../ReserveCard";
import { ShiftTimeline } from "../ShiftTimeline";

const { reserveMock, reverseMock, timelineMock } = vi.hoisted(() => ({
  reserveMock: vi.fn(),
  reverseMock: vi.fn(),
  timelineMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    getAdminReserve: reserveMock,
    reverseReserveMovement: reverseMock,
    getAdminShiftTimeline: timelineMock,
  };
});

/** Cifras que no pueden salir de ningún otro lado que el servidor. */
const RESERVA: AdminReserve = {
  enabled: true,
  amount: 300_000,
  loans_outstanding: 50_000,
  open_loans: [{ shift_id: 9, amount: 50_000, shift_open: true }],
  movements: [
    {
      id: 21,
      shift_id: 9,
      kind: "take",
      amount: 50_000,
      employee_name: "Ana",
      authorized_by_employee_name: "Supervisor",
      at: "2026-09-19T15:00:00Z",
      reversed_at: null,
      shift_open: true,
    },
    {
      id: 20,
      shift_id: 8,
      kind: "return",
      amount: 20_000,
      employee_name: "Luis",
      at: "2026-09-18T15:00:00Z",
      reversed_at: "2026-09-18T16:00:00Z",
      reversed_reason: "Se tecleó dos veces",
      shift_open: false,
    },
  ],
  checks: [],
};

describe("ReserveCard — la base de respaldo en Caja › Dinero", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveMock.mockResolvedValue(RESERVA);
  });

  it("con cash.reserve apagada no se dibuja ni se pide", () => {
    renderWithProviders(<ReserveCard storeId={1} />, { me: buildMe({ features: {} }) });
    expect(screen.queryByText("Base de respaldo")).not.toBeInTheDocument();
    expect(reserveMock).not.toHaveBeenCalled();
  });

  it("muestra lo que manda el servidor y reversa con motivo sólo lo del turno abierto", async () => {
    reverseMock.mockResolvedValue({ ...RESERVA.movements[0], reversed_at: "2026-09-19T16:00:00Z" });
    const user = userEvent.setup();
    renderWithProviders(<ReserveCard storeId={1} />, { me: buildMe({ features: { "cash.reserve": true } }) });

    const card = await screen.findByRole("region", { name: "Base de respaldo" });
    expect(card).toHaveTextContent(/300\.000/);
    expect(card).toHaveTextContent(/50\.000/);
    expect(within(card).getAllByRole("link", { name: "Turno #9" }).length).toBeGreaterThan(0);

    await user.click(screen.getByText(/Movimientos recientes \(2\)/));
    // El reversado no se vuelve a ofrecer; el del turno abierto sí.
    expect(screen.getByText(/Reversado: Se tecleó dos veces/)).toBeInTheDocument();
    const botones = screen.getAllByRole("button", { name: "Reversar" });
    expect(botones).toHaveLength(1);

    await user.click(botones[0]!);
    const confirmar = await screen.findByRole("button", { name: "Confirmar" });
    expect(confirmar).toBeDisabled();
    await user.type(screen.getByLabelText("Motivo (obligatorio)"), "Se tecleó mal");
    await user.click(confirmar);
    await waitFor(() => expect(reverseMock).toHaveBeenCalledWith(1, 21, { reason: "Se tecleó mal" }));
  });
});

describe("ShiftTimeline — la cronología del turno en la tarjeta de Cuadres", () => {
  it("se pide recién al abrirla y pinta los renglones que redacta el servidor", async () => {
    timelineMock.mockResolvedValue([
      { at: "2026-09-19T12:00:00Z", kind: "open", summary: "Abrió el turno", employee_name: "Ana" },
      { at: "2026-09-19T15:00:00Z", kind: "reserve_take", summary: "Tomó de la base de respaldo $ 50.000", employee_name: "Ana" },
    ]);
    const user = userEvent.setup();
    renderWithProviders(<ShiftTimeline shiftId={7} />, { me: buildMe() });
    expect(timelineMock).not.toHaveBeenCalled();

    await user.click(screen.getByText("Cronología del turno"));
    expect(await screen.findByText("Abrió el turno")).toBeInTheDocument();
    expect(screen.getByText(/Tomó de la base de respaldo/)).toBeInTheDocument();
    expect(timelineMock).toHaveBeenCalledWith(7);
  });
});
