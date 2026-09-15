import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { PaymentTargetPanel, type PaymentTarget } from "../PaymentTargetPanel";

vi.mock("@/api/payments", async () => {
  const actual = await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return { ...actual, payOrder: vi.fn(), listDevicePaymentMethods: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { listDevicePaymentMethods } = await import("@/api/payments");

describe("PaymentTargetPanel — A-10 (venta y propina, nunca sumadas por el cliente)", () => {
  it("pinta «Venta» y «Propina» por separado, nunca un «Total a cobrar» calculado en el cliente", async () => {
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
