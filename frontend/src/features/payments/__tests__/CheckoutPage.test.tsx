import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import type { SubAccountOut } from "@/api/orders";
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
  return { ...actual, getLastDocument: vi.fn(), getDocument: vi.fn() };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { getOrder, presentBill, listSubAccounts, splitBill } = await import("@/api/orders");
const { getDocument } = await import("@/api/documents");
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
    expect(screen.getByText(/¿desea incluir servicio voluntario del 10%\?/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sí, \$\s?4\.630/i }));
    // La venta y la propina se discriminan (propina separada de la venta y
    // del impuesto, regla dura), Y se muestra lo que hay que cobrar: sin ese
    // número el mesero suma de cabeza frente al cliente.
    expect(await screen.findByText("Venta")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?50\.000/).length).toBeGreaterThan(0);
    expect(screen.getByText("Propina")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?4\.630/).length).toBeGreaterThan(0);
    expect(screen.getByText("Total a cobrar")).toBeInTheDocument();
    expect(screen.getAllByText(/\$\s?54\.630/).length).toBeGreaterThan(0);
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

describe("CheckoutPage — cuenta dividida por ítems: partes como filas numeradas", () => {
  function subAccount(overrides: Partial<SubAccountOut> & { id: number; seq: number }): SubAccountOut {
    return {
      label: `Cuenta ${overrides.seq}`,
      seat: null,
      status: "open",
      items: [],
      totals: { subtotal: 41800, discount_total: 0, tax_lines: [], tax_total: 3096, total: 41800 },
      tip: null,
      document_id: null,
      ...overrides,
    };
  }

  const PARTES: SubAccountOut[] = [
    subAccount({ id: 1, seq: 1, status: "paid", document_id: 901 }),
    subAccount({ id: 2, seq: 2, status: "paid", document_id: 902, label: "Constructora" }),
    subAccount({ id: 3, seq: 3 }),
    subAccount({ id: 4, seq: 4, totals: { total: 43600 } }),
  ];

  beforeEach(() => {
    vi.mocked(getOrder).mockReset();
    vi.mocked(listSubAccounts).mockReset();
    vi.mocked(splitBill).mockReset();
    vi.mocked(getDocument).mockReset();
    vi.mocked(listDevicePaymentMethods).mockReset().mockResolvedValue(DEVICE_PAYMENT_METHODS);
    vi.mocked(getOrder).mockResolvedValue(buildOrder({ status: "to_pay", sub_accounts: PARTES }));
    vi.mocked(listSubAccounts).mockResolvedValue(PARTES);
    vi.mocked(getDocument).mockImplementation(async (id: number) =>
      id === 901
        ? { id, document_type: "pos_equivalent", payments: [{ method: "card", label: "Tarjeta", amount: 41800 }] }
        : { id, document_type: "invoice", payments: [{ method: "cash", label: "Efectivo", amount: 41800 }] },
    );
  });

  async function filas() {
    const lista = await screen.findByRole("list", { name: "Partes de la cuenta" });
    return within(lista).getAllByRole("listitem");
  }

  it("numera las partes en orden, con su monto del servidor y su estado en palabras", async () => {
    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": true });

    const rows = await filas();
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveTextContent(/Parte 1/);
    expect(rows[0]).toHaveTextContent(/Cobrada/);
    expect(rows[2]).toHaveTextContent(/Parte 3.*Sigue.*\$\s?41\.800/);
    expect(rows[2]).toHaveAttribute("aria-current", "step");
    expect(rows[3]).toHaveTextContent(/Parte 4.*Pendiente.*\$\s?43\.600/);
    // El nombre de fábrica no se repite; uno puesto a mano, sí.
    expect(rows[0]).not.toHaveTextContent(/Cuenta 1/);
    expect(rows[1]).toHaveTextContent(/Constructora/);
  });

  it("una parte cobrada dice con qué se pagó y si salió con factura, según su comprobante", async () => {
    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": true });

    const rows = await filas();
    await waitFor(() => expect(rows[0]).toHaveTextContent(/Cobrada · Tarjeta/));
    expect(rows[0]).not.toHaveTextContent(/con factura/);
    await waitFor(() => expect(rows[1]).toHaveTextContent(/Efectivo · con factura/));
    expect(getDocument).toHaveBeenCalledWith(901);
    expect(getDocument).toHaveBeenCalledWith(902);
  });

  it("el botón principal repite la parte y el monto, y recién ahí abre el cobro de esa parte", async () => {
    const user = userEvent.setup();
    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": true });

    const cobrar = await screen.findByRole("button", { name: /^Cobrar parte 3 · \$\s?41\.800$/ });
    expect(screen.queryByText("Pagos")).not.toBeInTheDocument();

    await user.click(cobrar);

    expect(await screen.findByText("Pagos")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Cobrar parte/ })).not.toBeInTheDocument();
  });

  it("tocar una parte pendiente la pasa adelante", async () => {
    const user = userEvent.setup();
    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": true });

    const rows = await filas();
    await user.click(within(rows[3]).getByRole("button"));

    expect(await screen.findByRole("button", { name: /^Cobrar parte 4 · \$\s?43\.600$/ })).toBeInTheDocument();
    expect((await filas())[3]).toHaveAttribute("aria-current", "step");
  });

  it("con partes ya cobradas no ofrece rehacer la división ni cobrar todo junto", async () => {
    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": true });

    await filas();
    expect(await screen.findByText(/la división no se puede cambiar/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cobrar todo junto" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dividir cuenta" })).not.toBeInTheDocument();
  });
});

describe("CheckoutPage — partes iguales", () => {
  it("pinta las partes de `per_part` como filas numeradas, sin calcular ninguna", async () => {
    vi.mocked(getOrder).mockReset().mockResolvedValue(buildOrder());
    vi.mocked(listDevicePaymentMethods).mockReset().mockResolvedValue(DEVICE_PAYMENT_METHODS);
    vi.mocked(splitBill).mockReset().mockResolvedValue({ mode: "equal", parts: 3, per_part: [16667, 16667, 16666], total: 50000 });
    const user = userEvent.setup();
    renderCheckout({ "pos.pre_bill": false, "pos.tips": false, "pos.split_bill": true });

    await user.click(await screen.findByRole("button", { name: "Partes iguales" }));
    const partes = screen.getByLabelText("Partes");
    await user.clear(partes);
    await user.type(partes, "3");
    await user.click(screen.getByRole("button", { name: "Calcular partes" }));

    const lista = await screen.findByRole("list", { name: "Partes de la cuenta" });
    const rows = within(lista).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(/Parte 1.*Pendiente.*\$\s?16\.667/);
    expect(rows[2]).toHaveTextContent(/Parte 3.*Pendiente.*\$\s?16\.666/);
    expect(screen.getByText(/se cobran juntas, en un solo comprobante/i)).toBeInTheDocument();
  });
});
