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
  // Motivo del cambio de rótulos: el handoff (`PosCobro`) llama «Consumo» a
  // la venta y «Propina (no es venta)» a la propina, en un libro con doble
  // raya; el total grande dice siempre «Total a cobrar». Lo que se prueba es
  // lo mismo: venta y propina discriminadas, y el total que hay que cobrar.
  it("sin propina, el libro no inventa una línea de propina: el consumo ES lo que se cobra", async () => {
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

    expect(await screen.findByText("Consumo")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?50\.000/).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/total a cobrar/i)).length).toBeGreaterThan(0);
    expect(screen.queryByText("Propina, no es venta")).not.toBeInTheDocument();
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
    await user.click(await screen.findByRole("button", { name: /10 % sugerida \$\s?7\.870/i }));

    // Venta y propina siguen discriminadas (la propina va aparte de la venta
    // y del impuesto), pero el total existe: sin él, el mesero suma de cabeza
    // delante del cliente. 85.000 + 7.870.
    expect(await screen.findByText("Consumo")).toBeInTheDocument();
    expect(screen.getByText("Propina, no es venta")).toBeInTheDocument();
    expect(await screen.findAllByText("Total a cobrar")).toHaveLength(2);
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
