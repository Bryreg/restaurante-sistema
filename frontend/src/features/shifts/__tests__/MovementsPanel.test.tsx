import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { CASH_MOVEMENT_CAUSES, type CashMovement, type ShiftSummary } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CAUSE_LABEL, MovementsPanel } from "../MovementsPanel";

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

/**
 * Ronda 2, H-8: `backend/app/shifts/schemas.py:26` ya declaraba
 * `"supplier_payment"` y el cliente tenía el tipo desactualizado. Este test
 * es la causa raíz arreglada: recorre la lista cerrada de causas
 * (`CASH_MOVEMENT_CAUSES`, un `const` recorrible, no una unión de
 * literales suelta) y exige una etiqueta no vacía en `CAUSE_LABEL` para
 * CADA una — la próxima causa que el backend agregue y nadie traduzca
 * rompe ESTE test, en vez de salir en blanco (`""`) en la tabla de
 * movimientos o en el desplegable de captura.
 */
describe("MovementsPanel — CAUSE_LABEL cubre toda causa cerrada", () => {
  it("tiene una etiqueta no vacía para cada miembro de CASH_MOVEMENT_CAUSES", () => {
    expect(CASH_MOVEMENT_CAUSES.length).toBeGreaterThan(0);
    for (const cause of CASH_MOVEMENT_CAUSES) {
      expect(CAUSE_LABEL[cause]).toBeTruthy();
      expect(CAUSE_LABEL[cause].trim().length).toBeGreaterThan(0);
    }
  });

  it("supplier_payment no dice «Egreso» ni «Salida»: kind ya distingue ingreso de egreso", () => {
    expect(CAUSE_LABEL.supplier_payment).toBe("Pago a proveedor");
    expect(CAUSE_LABEL.supplier_payment.toLowerCase()).not.toMatch(/egreso|salida/);
  });
});
