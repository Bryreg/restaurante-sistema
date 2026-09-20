import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { DeliveryPendingList, DeliverySettlement } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { DeliverySettlementPanel } from "../DeliverySettlementPanel";

const { PENDING, createDeliverySettlementMock, voidDeliverySettlementMock } = vi.hoisted(() => ({
  PENDING: {
    store_id: 1,
    couriers: [
      {
        courier_employee_id: 7,
        courier_employee_name: "Carlos",
        payments_count: 3,
        amount: 27_000,
        tip_amount: 3_000,
        total: 30_000,
      },
    ],
    amount: 27_000,
    tip_amount: 3_000,
    total: 30_000,
  } satisfies DeliveryPendingList,
  createDeliverySettlementMock: vi.fn(),
  voidDeliverySettlementMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    listPendingDeliveryCash: vi.fn().mockResolvedValue(PENDING),
    createDeliverySettlement: createDeliverySettlementMock,
    voidDeliverySettlement: voidDeliverySettlementMock,
  };
});

/**
 * "El efectivo de domicilios en el turno" (misión de este agente): la
 * pantalla pinta los renglones tal como los manda el servidor (nunca suma
 * "amount + tip_amount" a mano) y liquidar/deshacer no piden PIN — la
 * comanda de domicilio y `DeliverySettlementIn` no lo llevan.
 */
describe("DeliverySettlementPanel", () => {
  it("pinta el pendiente por domiciliario tal como llega, sin recalcular el total", async () => {
    renderWithProviders(<DeliverySettlementPanel shiftId={1} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(screen.getByText("Carlos")).toBeInTheDocument());
    const row = screen.getByText("Carlos").closest("tr") as HTMLElement;
    expect(row.textContent).toContain("27.000");
    expect(row.textContent).toContain("3.000");
    expect(row.textContent).toContain("30.000");
  });

  it("deja escrito que la propina no mueve el esperado del turno (iteración 2, H-1)", async () => {
    renderWithProviders(<DeliverySettlementPanel shiftId={1} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(screen.getByText("Carlos")).toBeInTheDocument());

    // El bloque de totales dice, en el rótulo, qué mueve el esperado y qué no.
    expect(screen.getByText(/Efectivo — entra al cajón y mueve el esperado al liquidar/)).toBeInTheDocument();
    expect(
      screen.getByText(/Propina — entra al cajón pero no mueve el esperado/),
    ).toBeInTheDocument();

    // La aclaración de una oración arriba de la tabla dice lo mismo con otras palabras.
    expect(screen.getByText(/no mueve el esperado — se paga como propina/)).toBeInTheDocument();

    // Los números pintados son los MISMOS de siempre (amount=27.000, tip_amount=3.000, total=30.000).
    const row = screen.getByText("Carlos").closest("tr") as HTMLElement;
    expect(row.textContent).toContain("27.000");
    expect(row.textContent).toContain("3.000");
    expect(row.textContent).toContain("30.000");
  });

  it("iteración 3 (H-8): el rótulo de propina dice qué pasa DESPUÉS de liquidar, sin tocar los números", async () => {
    renderWithProviders(<DeliverySettlementPanel shiftId={1} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(screen.getByText("Carlos")).toBeInTheDocument());

    // La primera mitad del rótulo (iteración 2) se conserva letra por letra.
    const tipLabel = screen.getByText(/Propina — entra al cajón pero no mueve el esperado/);
    expect(tipLabel).toBeInTheDocument();
    // La segunda mitad (nueva) dice que, ya liquidada, sale del cajón al cierre como propina —
    // nunca que "mueve el esperado" ni que es plata a consignar.
    expect(tipLabel.textContent).toMatch(/al cerrar el turno sale del cajón como propina/);
    expect(tipLabel.textContent).not.toMatch(/mueve el esperado[^;]*$/);
    expect(tipLabel.textContent?.toLowerCase()).not.toContain("consignar el esperado");

    // La aclaración de una oración arriba de la tabla dice lo mismo con otras palabras.
    expect(
      screen.getByText(/al cerrar el turno sale del cajón como tal, nunca como plata a consignar/),
    ).toBeInTheDocument();

    // Los encabezados de la tabla por domiciliario también lo dicen, sin cambiar amount/tip_amount/total.
    expect(screen.getByText("Efectivo (mueve el esperado)")).toBeInTheDocument();
    expect(screen.getByText("Propina (no mueve el esperado; sale al cierre como propina)")).toBeInTheDocument();

    // Los números pintados siguen siendo los MISMOS (amount=27.000, tip_amount=3.000, total=30.000):
    // el ajuste es sólo de texto, no de la fuente de datos.
    const row = screen.getByText("Carlos").closest("tr") as HTMLElement;
    expect(row.textContent).toContain("27.000");
    expect(row.textContent).toContain("3.000");
    expect(row.textContent).toContain("30.000");
    const totalsBlock = screen.getByText(/Total pendiente/).closest("div") as HTMLElement;
    expect(totalsBlock.textContent).toContain("30.000");
  });

  it("liquidar manda el courier_employee_id y no pide PIN", async () => {
    createDeliverySettlementMock.mockResolvedValueOnce({
      id: 501,
      courier_employee_name: "Carlos",
      total: 30_000,
      status: "settled",
    } satisfies DeliverySettlement);

    const user = userEvent.setup();
    renderWithProviders(<DeliverySettlementPanel shiftId={1} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(screen.getByText("Carlos")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "Liquidar" }));

    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Liquidar" }));

    await waitFor(() => expect(createDeliverySettlementMock).toHaveBeenCalledTimes(1));
    const [body] = createDeliverySettlementMock.mock.calls[0];
    expect(body.courier_employee_id).toBe(7);
    // Ni PIN ni pantalla de PIN: `DeliverySettlementIn` no lo lleva.
    expect(screen.queryByRole("group", { name: /pin/i })).not.toBeInTheDocument();

    // Tras liquidar, queda disponible para deshacerla desde esta misma pantalla.
    await waitFor(() => expect(screen.getByRole("button", { name: "Deshacer" })).toBeInTheDocument());
  });
});
