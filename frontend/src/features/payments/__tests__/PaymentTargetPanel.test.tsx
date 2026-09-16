import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { PaymentTargetPanel, type PaymentTarget } from "../PaymentTargetPanel";

vi.mock("@/api/payments", async () => {
  const actual = await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return { ...actual, payOrder: vi.fn(), listDevicePaymentMethods: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { listDevicePaymentMethods } = await import("@/api/payments");

describe("PaymentTargetPanel — A-10 (la venta discriminada, y el total que hay que cobrar)", () => {
  it("sin propina no agrega una línea de total redundante: «Venta» YA es lo que se cobra", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);

    const target: PaymentTarget = { totals: { total: 50000 }, tipInfo: null };

    renderWithProviders(
      <PaymentTargetPanel
        orderId={42}
        expectedVersion={3}
        target={target}
        tipsEnabled={false}
        onPaid={vi.fn()}
        onStale={vi.fn()}
        onAlreadyPaid={vi.fn()}
      />,
    );

    expect(await screen.findByText("Venta")).toBeInTheDocument();
    expect(screen.getByText(/\$\s?50\.000/)).toBeInTheDocument();
    expect(screen.queryByText(/total a cobrar/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Propina")).not.toBeInTheDocument();
  });

  it("con propina aceptada muestra el total a cobrar, que es el número que el mesero necesita", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);

    const target: PaymentTarget = {
      totals: { total: 85000 },
      tipInfo: { base: 78704, suggested_pct: 10, suggested_amount: 7870 },
    };

    renderWithProviders(
      <PaymentTargetPanel
        orderId={42}
        expectedVersion={3}
        target={target}
        tipsEnabled
        onPaid={vi.fn()}
        onStale={vi.fn()}
        onAlreadyPaid={vi.fn()}
      />,
    );

    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /sí, \$\s?7\.870/i }));

    // Venta y propina siguen discriminadas (la propina va aparte de la venta
    // y del impuesto), pero el total existe: sin él, el mesero suma de cabeza
    // delante del cliente. 85.000 + 7.870.
    expect(await screen.findByText("Venta")).toBeInTheDocument();
    expect(screen.getByText("Propina")).toBeInTheDocument();
    expect(screen.getByText("Total a cobrar")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?92\.870/).length).toBeGreaterThan(0);
  });

  it("null ≠ 0: sin totals.total todavía cargado, dice que no pudo calcular el total en vez de cobrar sobre $0", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);

    const target: PaymentTarget = { totals: {}, tipInfo: null };

    renderWithProviders(
      <PaymentTargetPanel
        orderId={42}
        expectedVersion={3}
        target={target}
        tipsEnabled={false}
        onPaid={vi.fn()}
        onStale={vi.fn()}
        onAlreadyPaid={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudo calcular el total/i);
    expect(screen.queryByText(/\$\s?0(?!\d)/)).not.toBeInTheDocument();
    expect(screen.queryByText("Pagos")).not.toBeInTheDocument();
  });
});
