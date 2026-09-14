import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import type { CashMovement, ShiftSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { MovementsPanel } from "../MovementsPanel";

const { createCashMovementMock } = vi.hoisted(() => ({
  createCashMovementMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  const summary: ShiftSummary = {
    id: 1,
    movements: [] as CashMovement[],
    swaps: [],
    pickups: [],
    handovers: [],
    roster: [],
  };
  return {
    ...actual,
    getShiftSummary: vi.fn().mockResolvedValue(summary),
    createCashMovement: createCashMovementMock,
  };
});

/**
 * "El formulario de movimiento reintenta con `authorizer_pin` tras
 * `PETTY_CASH_LIMIT`" (checklist del entregable de este agente).
 */
describe("MovementsPanel — reintento tras PETTY_CASH_LIMIT", () => {
  it("pide PIN de administrador y reenvía el movimiento con authorizer_pin", async () => {
    createCashMovementMock
      .mockRejectedValueOnce(new ApiError(400, "PETTY_CASH_LIMIT", "Pedí el PIN de un administrador"))
      .mockResolvedValueOnce({ id: 99 } satisfies CashMovement);

    const user = userEvent.setup();
    renderWithProviders(<MovementsPanel shiftId={1} />, { me: { kind: "device", features: {} } });

    await user.type(screen.getByLabelText("Monto"), "80000");
    await user.click(screen.getByRole("button", { name: /registrar movimiento/i }));

    await waitFor(() =>
      expect(screen.getByText(/pedí el pin de un administrador/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole("group", { name: /pin de administrador/i })).toBeInTheDocument();

    // Completa el PIN de 4 dígitos con el teclado accesible del PinPad.
    for (const digit of ["9", "9", "9", "9"]) {
      await user.click(screen.getByRole("button", { name: `Dígito ${digit}` }));
    }

    await waitFor(() => expect(createCashMovementMock).toHaveBeenCalledTimes(2));

    const [, secondBody, secondKey] = createCashMovementMock.mock.calls[1];
    expect(secondBody.authorizer_pin).toBe("9999");
    // La segunda vez lleva una Idempotency-Key distinta: el cuerpo cambió.
    const [, , firstKey] = createCashMovementMock.mock.calls[0];
    expect(secondKey).not.toBe(firstKey);
  });
});
