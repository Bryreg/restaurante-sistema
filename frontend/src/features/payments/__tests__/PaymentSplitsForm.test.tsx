import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMe, renderWithProviders } from "@/test/utils";

import { PaymentSplitsForm } from "../PaymentSplitsForm";

vi.mock("@/api/payments", async () => {
  const actual = await vi.importActual<typeof import("@/api/payments")>("@/api/payments");
  return {
    ...actual,
    payOrder: vi.fn(),
    listDevicePaymentMethods: vi.fn(),
    previewChange: vi.fn(),
    getTenderSuggestions: vi.fn(),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { listDevicePaymentMethods, previewChange, getTenderSuggestions } = await import("@/api/payments");

beforeEach(() => {
  // Cifras que la pantalla no podría inventar redondeando 50.000: si aparecen
  // es porque se pintó lo que dijo el servidor.
  vi.mocked(getTenderSuggestions).mockReset().mockResolvedValue({
    amount: 50000,
    exact: 50000,
    suggestions: [51_111, 62_222],
  });
});

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

    // El medio pasó de lista desplegable a fila de botones (auditoría de UX en
    // tablet: un toque en vez de dos). La regla que se prueba es la misma: se
    // ofrecen los medios habilitados de la sede y ninguno más.
    const medio = screen.getByRole("radiogroup", { name: "Medio" });
    expect(within(medio).getByRole("radio", { name: "Efectivo" })).toBeInTheDocument();
    expect(within(medio).getByRole("radio", { name: "Transferencia" })).toBeInTheDocument();
    // "Tarjeta"/"Bono"/"Plataforma"/"Otro" no están habilitados en la sede: no se ofrecen.
    expect(within(medio).queryByRole("radio", { name: "Tarjeta" })).not.toBeInTheDocument();
    expect(within(medio).queryByRole("radio", { name: "Bono" })).not.toBeInTheDocument();
    expect(within(medio).getAllByRole("radio")).toHaveLength(2);
  });

  it("tocar un medio lo elige: la referencia aparece sólo para el que la pide", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
      { code: "transfer", label: "Nequi", dian_code: "42", requires_reference: true },
    ]);

    renderForm();
    await screen.findByText("Pagos");
    const user = userEvent.setup();
    expect(screen.getByRole("radio", { name: "Efectivo" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Nequi" }));
    expect(screen.getByRole("radio", { name: "Nequi" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText(/referencia/i)).toBeInTheDocument();
    // Sin efectivo no hay «Recibido».
    expect(screen.queryByLabelText("Recibido")).not.toBeInTheDocument();
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

describe("PaymentSplitsForm — el vuelto antes de cobrar", () => {
  it("pinta el vuelto que calcula el servidor, sin hacer la cuenta en la pantalla", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);
    // Un valor que la pantalla NO podría inventar restando (100.000 − 50.000
    // sería 50.000): si aparece 7.777 es porque se pinta lo que dijo el servidor.
    vi.mocked(previewChange).mockClear();
    vi.mocked(previewChange).mockResolvedValue({
      splits: [{ change: 7777, short_by: null }],
      change_total: 7777,
    });

    renderForm();
    await screen.findByText("Pagos");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+$ 100.000" }));

    await waitFor(() => expect(previewChange).toHaveBeenCalledWith([{ amount: 50000, tendered: 100000 }]));
    expect(await screen.findByText("Vuelto a entregar")).toBeInTheDocument();
    expect(screen.getAllByText("$ 7.777").length).toBeGreaterThan(0);
    // Un billete, una consulta: se pregunta cuando se deja de teclear.
    expect(previewChange).toHaveBeenCalledTimes(1);
  });

  it("si lo recibido no alcanza lo dice, en vez de un vuelto de cero", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);
    vi.mocked(previewChange).mockResolvedValue({
      splits: [{ change: null, short_by: 30000 }],
      change_total: 0,
    });

    renderForm();
    await screen.findByText("Pagos");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+$ 20.000" }));

    expect(await screen.findByText(/lo recibido no alcanza: faltan \$ 30\.000/i)).toBeInTheDocument();
    expect(screen.queryByText("Vuelto a entregar")).not.toBeInTheDocument();
  });

  it("«Vuelto a entregar» espera a que el pago esté completo", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);
    vi.mocked(previewChange).mockResolvedValue({ splits: [{ change: 1234, short_by: null }], change_total: 1234 });

    renderForm();
    const monto = await screen.findByLabelText<HTMLInputElement>("Monto");
    const user = userEvent.setup();
    // Monto a medias (faltan $30.000) y recibido de sobra para ese monto.
    await user.clear(monto);
    await user.type(monto, "20000");
    await user.click(screen.getByRole("button", { name: "+$ 50.000" }));

    await waitFor(() => expect(previewChange).toHaveBeenCalledWith([{ amount: 20000, tendered: 50000 }]));
    expect(await screen.findByText(/faltan \$\s?30\.000/i)).toBeInTheDocument();
    expect(screen.queryByText("Vuelto a entregar")).not.toBeInTheDocument();
  });
});

describe("PaymentSplitsForm — lo recibido en un toque", () => {
  it("«Exacto» pone el monto y las cifras redondas son las del servidor", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);
    vi.mocked(previewChange).mockResolvedValue({ splits: [{ change: 0, short_by: null }], change_total: 0 });

    renderForm();
    await screen.findByText("Pagos");
    const user = userEvent.setup();

    await waitFor(() => expect(getTenderSuggestions).toHaveBeenCalledWith(50000));
    const atajos = await screen.findByRole("group", { name: "Recibido en un toque" });
    expect(await within(atajos).findByRole("button", { name: "$ 51.111" })).toBeInTheDocument();
    expect(within(atajos).getByRole("button", { name: "$ 62.222" })).toBeInTheDocument();

    await user.click(within(atajos).getByRole("button", { name: "Exacto" }));
    expect(screen.getByLabelText<HTMLInputElement>("Recibido").value).toBe("$ 50.000");

    await user.click(within(atajos).getByRole("button", { name: "$ 62.222" }));
    expect(screen.getByLabelText<HTMLInputElement>("Recibido").value).toBe("$ 62.222");
    // Los billetes que se suman siguen ahí, como segunda opción.
    expect(screen.getByRole("button", { name: "+$ 1.000" })).toBeInTheDocument();
  });

  it("el PIN está a la vista desde el principio y dice quién cobra", async () => {
    vi.mocked(listDevicePaymentMethods).mockResolvedValue([
      { code: "cash", label: "Efectivo", dian_code: "10", requires_reference: false },
    ]);
    renderWithProviders(
      <PaymentSplitsForm orderId={42} totalDue={50000} onPaid={vi.fn()} onStale={vi.fn()} onAlreadyPaid={vi.fn()} />,
      { me: buildMe({ kind: "device", employee: { id: 7, name: "Ana", role: "operator", can_charge: true } }) },
    );
    expect(await screen.findByRole("group", { name: "PIN propio para cobrar" })).toBeInTheDocument();
    expect(await screen.findByText("Ana")).toBeInTheDocument();
  });
});
