import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "@/test/utils";

import { PaymentSplitsForm } from "../PaymentSplitsForm";

vi.mock("@/api/payments", async () => {
  const actual = await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return { ...actual, payOrder: vi.fn(), listDevicePaymentMethods: vi.fn() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { listDevicePaymentMethods } = await import("@/api/payments");

function renderForm() {
  return renderWithProviders(
    <PaymentSplitsForm
      orderId={42}
      expectedVersion={3}
      totalDue={50000}
      onPaid={vi.fn()}
      onStale={vi.fn()}
      onAlreadyPaid={vi.fn()}
    />,
  );
}

describe("PaymentSplitsForm — medios de pago de la sede", () => {
  it("ofrece sólo los medios habilitados de GET /device/payment-methods, nunca los seis fijos", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
      { code: "transfer", label: "Transferencia", dian_code: "42", requires_reference: true },
    ]);

    renderForm();

    await screen.findByText("Pagos");
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Medio"));

    // El popup se monta en un portal: con 48 entornos jsdom compitiendo no está
    // montado todavía cuando `getByRole` síncrono pregunta. Esperar acá alcanza;
    // las aserciones siguientes ya encuentran el popup montado.
    expect(await screen.findByRole("option", { name: "Efectivo" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Transferencia" })).toBeInTheDocument();
    // "Tarjeta"/"Bono"/"Plataforma"/"Otro" no están habilitados en la sede: no se ofrecen.
    expect(screen.queryByRole("option", { name: "Tarjeta" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Bono" })).not.toBeInTheDocument();
  });

  it("sólo pide «Referencia» para el medio que el servidor marca requires_reference", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);

    renderForm();

    await screen.findByText("Pagos");
    expect(screen.queryByLabelText(/referencia/i)).not.toBeInTheDocument();
  });

  it("mientras carga la lista no ofrece cobrar; si falla, muestra el error legible con reintentar", async () => {
    vi.mocked(listDevicePaymentMethods).mockRejectedValue(new Error("Error del servidor (500). Intentá de nuevo."));

    renderForm();

    expect(await screen.findByRole("alert")).toHaveTextContent(/no se pudieron cargar los medios de pago/i);
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeInTheDocument();
  });

  it("sede sin medios habilitados: no ofrece una tabla de pagos con códigos inventados", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([]);

    renderForm();

    await waitFor(() =>
      expect(screen.getByText(/esta sede no tiene medios de pago habilitados/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText("Pagos")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// El monto que el sistema ya sabe
// ---------------------------------------------------------------------------
//
// Encontrado jugando una venta de mostrador: el campo «Monto» arrancaba
// vacío aunque el total estuviera en pantalla, y los botones rápidos llenan
// «Recibido», no «Monto». Mientras estuviera vacío la pantalla decía «Faltan
// $X» y el teclado del PIN quedaba bloqueado — seguro, pero dos pasos de más
// en cada venta, y es el número que más fácil se teclea mal con cola en la
// caja.

describe("PaymentSplitsForm — el monto arranca con lo que hay que cobrar", () => {
  const soloEfectivo = [{ code: "cash" as const, label: "Efectivo", dian_code: "10", requires_reference: false }];

  it("la primera fila viene con el total, sin teclear nada", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue(soloEfectivo);
    renderForm();

    const monto = await screen.findByLabelText<HTMLInputElement>("Monto");
    await waitFor(() => expect(monto.value).toBe("$ 50.000"));
    expect(screen.queryByText(/Faltan/)).not.toBeInTheDocument();
  });

  it("se puede bajar para armar un pago dividido, y la fila nueva trae lo que falta", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue(soloEfectivo);
    renderForm();

    const monto = await screen.findByLabelText<HTMLInputElement>("Monto");
    await waitFor(() => expect(monto.value).toBe("$ 50.000"));

    const user = userEvent.setup();
    await user.clear(monto);
    await user.type(monto, "20000");
    await waitFor(() => expect(screen.getByText(/Faltan .*30\.000/)).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "Agregar pago" }));
    const montos = await screen.findAllByLabelText<HTMLInputElement>("Monto");
    expect(montos).toHaveLength(2);
    await waitFor(() => expect(montos[1]!.value).toBe("$ 30.000"));
    expect(screen.queryByText(/Faltan/)).not.toBeInTheDocument();
  });

  it("una fila que ya se editó no vuelve a seguir al total", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue(soloEfectivo);
    renderForm();

    const monto = await screen.findByLabelText<HTMLInputElement>("Monto");
    await waitFor(() => expect(monto.value).toBe("$ 50.000"));

    const user = userEvent.setup();
    await user.clear(monto);
    await user.type(monto, "20000");
    await waitFor(() => expect(monto.value).toBe("20000"));
    // Sin más interacción, lo tecleado se queda: nada lo pisa.
    await new Promise((r) => setTimeout(r, 50));
    expect(monto.value).toBe("20000");
  });
});
