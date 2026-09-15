import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import { buildMe, renderWithProviders } from "@/test/utils";

import CheckoutPage from "../CheckoutPage";
import { buildOrder, buildPaymentOut, buildPreBill } from "./fixtures";

vi.mock("@/api/orders", async () => {
  const actual = await vi.importActual<typeof import("@/api/orders")>("@/api/orders");
  return {
    ...actual,
    getOrder: vi.fn(),
    presentBill: vi.fn(),
    listSubAccounts: vi.fn(),
    splitBill: vi.fn(),
  };
});

vi.mock("@/api/payments", async () => {
  const actual = await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return { ...actual, payOrder: vi.fn() };
});

vi.mock("@/api/documents", async () => {
  const actual = await vi.importActual<typeof import("@/api/documents")>("@/api/documents");
  return { ...actual, getLastDocument: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { getOrder, presentBill } = await import("@/api/orders");
const { payOrder } = await import("@/api/payments");
const { toast } = await import("sonner");

function DocumentProbe() {
  const { documentId } = useParams();
  return <div>Documento {documentId}</div>;
}

function renderCheckout(features: Record<string, boolean>) {
  return renderWithProviders(
    <Routes>
      <Route path="/pos/cobro/:orderId" element={<CheckoutPage />} />
      <Route path="/pos/documento/:documentId" element={<DocumentProbe />} />
      <Route path="/pos/mesas" element={<div>Mapa de mesas</div>} />
    </Routes>,
    {
      route: "/pos/cobro/42",
      me: buildMe({
        kind: "device",
        employee: { id: 7, name: "Ana", role: "operator", can_charge: true },
        store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: ["dine_in"] },
        features,
      }),
    },
  );
}

describe("CheckoutPage", () => {
  beforeEach(() => {
    vi.mocked(getOrder).mockReset();
    vi.mocked(presentBill).mockReset();
    vi.mocked(payOrder).mockReset();
    vi.mocked(toast.success).mockClear();
  });

  it("con pos.pre_bill encendida presenta la cuenta, muestra la leyenda tal cual llega y pregunta la propina", async () => {
    const order = buildOrder({ bill_presented_at: null });
    vi.mocked(getOrder).mockResolvedValue(order);
    vi.mocked(presentBill).mockResolvedValue(buildPreBill());
    const user = userEvent.setup();

    renderCheckout({ "pos.pre_bill": true, "pos.tips": true, "pos.split_bill": false });

    await waitFor(() => expect(presentBill).toHaveBeenCalledTimes(1));
    const presentBillCall = vi.mocked(presentBill).mock.calls[0];
    expect(presentBillCall[0]).toBe(42);
    expect(presentBillCall[1]).toEqual({ expected_version: 3 });
    expect(typeof presentBillCall[2]).toBe("string");

    expect(await screen.findByText("NO ES FACTURA — documento informativo")).toBeInTheDocument();
    expect(screen.getByText(/¿desea incluir servicio voluntario del 10%\?/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sí, \$\s?4\.630/i }));
    expect(await screen.findByText(/propina: \$\s?4\.630/i)).toBeInTheDocument();
    expect(screen.getByText(/total a cobrar: \$\s?54\.630/i)).toBeInTheDocument();
  });

  it("con pos.tips apagada no pregunta propina", async () => {
    vi.mocked(getOrder).mockResolvedValue(buildOrder());

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    expect(screen.queryByText(/¿desea incluir servicio voluntario/i)).not.toBeInTheDocument();
  });

  it("con pos.split_bill apagada no ofrece dividir la cuenta", async () => {
    vi.mocked(getOrder).mockResolvedValue(buildOrder());

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    expect(screen.queryByRole("button", { name: "Partes iguales" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Por ítems" })).not.toBeInTheDocument();
  });

  it("splits: agregar pagos, muestra «faltan $X» y luego «Completo»", async () => {
    vi.mocked(getOrder).mockResolvedValue(buildOrder());
    const user = userEvent.setup();

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    expect(screen.getByText(/faltan \$\s?50\.000/i)).toBeInTheDocument();

    const amountInput = screen.getByLabelText("Monto");
    await user.click(amountInput);
    await user.type(amountInput, "50000");
    await user.tab();

    expect(await screen.findByText("Completo")).toBeInTheDocument();
  });

  it("cobra con PIN propio, manda Idempotency-Key y pinta el cambio que devuelve el servidor", async () => {
    const order = buildOrder();
    vi.mocked(getOrder).mockResolvedValue(order);
    vi.mocked(payOrder).mockResolvedValue(buildPaymentOut({ change: 7370, document: { id: 555 } }));
    const user = userEvent.setup();

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    const amountInput = screen.getByLabelText("Monto");
    await user.click(amountInput);
    await user.type(amountInput, "50000");
    await user.tab();
    await screen.findByText("Completo");

    await user.keyboard("1234");

    await waitFor(() => expect(payOrder).toHaveBeenCalledTimes(1));
    const [orderId, body, idempotencyKey] = vi.mocked(payOrder).mock.calls[0];
    expect(orderId).toBe(42);
    expect(body.pin).toBe("1234");
    expect(body.expected_version).toBe(3);
    expect(body.splits).toEqual([{ method: "cash", amount: 50000, tendered: undefined, reference: undefined }]);
    expect(typeof idempotencyKey).toBe("string");

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(vi.mocked(toast.success).mock.calls[0][0]).toContain("7.370");

    expect(await screen.findByText("Documento 555")).toBeInTheDocument();
  });

  it("409 STALE_VERSION reemplaza la comanda local por extra.order y muestra el aviso", async () => {
    const order = buildOrder();
    const updatedOrder = buildOrder({
      version: 5,
      totals: { subtotal: 61000, discount_total: 0, tax_lines: [{ rate: 8, base: 56482, tax: 4518 }], tax_total: 4518, total: 61000 },
    });
    // Primera carga trae la comanda vieja; el sondeo/`invalidateQueries`
    // posterior al 409 vuelve a pedirla y el servidor (ya consistente con
    // `extra.order`) devuelve la actualizada — como pasaría en producción.
    vi.mocked(getOrder).mockResolvedValueOnce(order).mockResolvedValue(updatedOrder);
    vi.mocked(payOrder).mockRejectedValue(
      new ApiError(409, "STALE_VERSION", "La comanda cambió en otra tablet; revisá y repetí.", { order: updatedOrder }),
    );
    const user = userEvent.setup();

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    const amountInput = screen.getByLabelText("Monto");
    await user.click(amountInput);
    await user.type(amountInput, "50000");
    await user.tab();
    await screen.findByText(/ingresá tu pin para cobrar/i);

    await user.keyboard("1234");

    expect(await screen.findByRole("alert")).toHaveTextContent(/la comanda cambió en otra tablet/i);
    await waitFor(() => {
      expect(screen.getAllByText(/\$\s?61\.000/).length).toBeGreaterThan(0);
    });
  });
});
