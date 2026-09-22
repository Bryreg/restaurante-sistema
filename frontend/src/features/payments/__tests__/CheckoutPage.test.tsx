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
  return { ...actual, payOrder: vi.fn(), listDevicePaymentMethods: vi.fn() };
});

vi.mock("@/api/documents", async () => {
  const actual = await vi.importActual<typeof import("@/api/documents")>("@/api/documents");
  return { ...actual, getLastDocument: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { getOrder, presentBill } = await import("@/api/orders");
const { payOrder, listDevicePaymentMethods } = await import("@/api/payments");
const { toast } = await import("sonner");

const DEVICE_PAYMENT_METHODS = [
  { code: "cash" as const, label: "Efectivo", dian_code: "10", requires_reference: false },
  { code: "card" as const, label: "Tarjeta", dian_code: "48", requires_reference: true },
];

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
    vi.mocked(listDevicePaymentMethods).mockReset().mockResolvedValue(DEVICE_PAYMENT_METHODS);
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
    // La pregunta de propina con la forma de `m2b`: tres opciones, y el
    // porcentaje del botón es el que manda el servidor — la pantalla nunca
    // saca un porcentaje de la base por su cuenta.
    expect(screen.getByRole("heading", { name: "Propina" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /no incluir/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /otro valor/i })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /10%\s*·\s*\$\s?4\.630/i }));
    // La venta y la propina se discriminan (propina separada de la venta y
    // del impuesto, regla dura), Y se muestra lo que hay que cobrar: sin ese
    // número el mesero suma de cabeza frente al cliente.
    expect(await screen.findByText("Venta")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?50\.000/).length).toBeGreaterThan(0);
    // «Propina» aparece dos veces a propósito: el título de la tarjeta de
    // `m2b` y el renglón del desglose del cobro. Se busca el del desglose,
    // que es el que lleva la cifra al lado.
    expect(screen.getAllByText("Propina").length).toBeGreaterThan(1);
    expect(screen.getAllByText(/\$\s?4\.630/).length).toBeGreaterThan(0);
    expect(screen.getByText("Total a cobrar")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?54\.630/).length).toBeGreaterThan(0);
  });

  it("con pos.tips apagada no pregunta propina", async () => {
    vi.mocked(getOrder).mockResolvedValue(buildOrder());

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    expect(screen.queryByRole("heading", { name: "Propina" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /no incluir/i })).not.toBeInTheDocument();
  });

  it("con pos.split_bill apagada no ofrece dividir la cuenta", async () => {
    vi.mocked(getOrder).mockResolvedValue(buildOrder());

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    expect(screen.queryByRole("button", { name: "Partes iguales" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Por ítems" })).not.toBeInTheDocument();
  });

  it("arranca completo con el total puesto, y la guía «faltan $X» aparece al bajarlo", async () => {
    // El monto ya no arranca vacío: la primera fila viene con lo que hay que
    // cobrar, porque el sistema ya lo sabe y obligar a teclearlo en cada venta
    // de mostrador era un paso de más (y el número que más fácil se teclea mal
    // con cola en la caja). La guía de saldo sigue existiendo — se ve cuando
    // alguien baja el monto para armar un pago dividido.
    vi.mocked(getOrder).mockResolvedValue(buildOrder());
    const user = userEvent.setup();

    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": false });

    await screen.findByText("Pagos");
    expect(await screen.findByText("Completo")).toBeInTheDocument();
    expect(screen.queryByText(/faltan/i)).not.toBeInTheDocument();

    const amountInput = screen.getByLabelText("Monto");
    await user.clear(amountInput);
    await user.type(amountInput, "20000");
    expect(await screen.findByText(/faltan \$\s?30\.000/i)).toBeInTheDocument();

    await user.clear(amountInput);
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
    // El monto llega puesto: el cajero sólo teclea su PIN.
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
    await screen.findByText(/ingresá tu pin para cobrar/i);

    await user.keyboard("1234");

    expect(await screen.findByRole("alert")).toHaveTextContent(/la comanda cambió en otra tablet/i);
    await waitFor(() => {
      expect(screen.getAllByText(/\$\s?61\.000/).length).toBeGreaterThan(0);
    });
  });
});
