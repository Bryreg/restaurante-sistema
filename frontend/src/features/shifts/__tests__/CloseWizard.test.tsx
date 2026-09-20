import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import type { CloseCountResult, CloseReview, ShiftTips } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CloseWizard } from "../CloseWizard";

const { closeCountMock, getCloseReviewMock, confirmCloseMock, getShiftTipsMock } = vi.hoisted(() => ({
  closeCountMock: vi.fn(),
  getCloseReviewMock: vi.fn(),
  confirmCloseMock: vi.fn(),
  getShiftTipsMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    closeCount: closeCountMock,
    getCloseReview: getCloseReviewMock,
    confirmClose: confirmCloseMock,
    getShiftTips: getShiftTipsMock,
  };
});

const FIRST_REVIEW: CloseReview = {
  count_id: 7,
  expected: 250_000,
  difference: -5_000,
  equation: { base: 200_000, cash_sales: 60_000, incomes: 0, expenses: 10_000, pickups: 0 },
  card: { registered: 0, counted: 0, difference: 0 },
  transfer: { registered: 0, counted: 0, difference: 0 },
  requires_cause: true,
  requires_identified_cause: false,
  is_critical: false,
  closes_day_suggested: false,
};

// Sin causa obligatoria: esta review sirve para probar el camino de
// DIFFERENCE_CHANGED sin depender de abrir un `<Select>` de base-ui en
// jsdom (una interacción aparte, ya cubierta por otros agentes/tests).
const NO_CAUSE_REVIEW: CloseReview = { ...FIRST_REVIEW, difference: 0, requires_cause: false };
const CHANGED_REVIEW: CloseReview = { ...NO_CAUSE_REVIEW, difference: -8_000 };

describe("CloseWizard — cierre a ciegas en tres pasos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getShiftTipsMock.mockResolvedValue({ cash_out: 12_345 } satisfies ShiftTips);
  });

  it("iteración 3 (H-8): pinta el cash_out de GET /shifts/{id}/tips como referencia, sin recalcularlo", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);

    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });

    await waitFor(() => expect(getShiftTipsMock).toHaveBeenCalledWith(1));
    // El monto que llega de `cash_out` se pinta tal cual (formatCOP de 12.345), no recalculado.
    await waitFor(() => expect(screen.getByText(/12\.345/)).toBeInTheDocument());
    // El rótulo deja claro que es una referencia, no un dato que se use para calcular nada.
    expect(screen.getByText(/Referencia del sistema/)).toBeInTheDocument();
  });

  it("el paso 1 no muestra el esperado ni llama a la revisión antes de tener count_id", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(FIRST_REVIEW);

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });

    // La palabra "esperado" puede aparecer en el texto explicativo del paso
    // 1 ("sin mirar lo esperado"); lo que nunca debe existir es la ETIQUETA
    // con la cifra, que en el paso 2 es un elemento cuyo texto es
    // exactamente "Esperado".
    expect(screen.queryByText(/^esperado$/i)).not.toBeInTheDocument();
    expect(getCloseReviewMock).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(closeCountMock).toHaveBeenCalledTimes(1));
    // Recién después de tener `count_id` puede dispararse la revisión.
    await waitFor(() => expect(getCloseReviewMock).toHaveBeenCalledWith(1, 7));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
  });

  it("ante 400 DIFFERENCE_CHANGED vuelve al paso 2 con la review nueva", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(NO_CAUSE_REVIEW);
    confirmCloseMock.mockRejectedValueOnce(
      new ApiError(400, "DIFFERENCE_CHANGED", "La diferencia cambió", { review: CHANGED_REVIEW }),
    );

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });

    await user.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());

    // Paso 2 → paso 3. Sin diferencia (0) no exige causa: se puede confirmar directo.
    await user.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /confirmar cierre/i })).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /confirmar cierre/i }));

    await waitFor(() => expect(confirmCloseMock).toHaveBeenCalledTimes(1));
    // Vuelve al paso 2 con la diferencia de la review NUEVA, no la vieja.
    await waitFor(() => expect(screen.getByText(/-8\.000|8\.000/)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /confirmar cierre/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Lo que encontró la demo de un día de venta
// ---------------------------------------------------------------------------

describe("CloseWizard — el lote del datáfono y las comandas abiertas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getShiftTipsMock.mockResolvedValue({ cash_out: 0 } satisfies ShiftTips);
  });

  const conTarjeta: CloseReview = {
    ...NO_CAUSE_REVIEW,
    card: { registered: 126_741, sales: 116_000, tips: 10_741, counted: 126_741, difference: 0 },
  };

  it("muestra de qué se compone lo que tiene que marcar el datáfono", async () => {
    // El defecto: el cierre comparaba contra la venta sola, así que todo
    // turno con propinas de tarjeta descuadraba por el monto exacto de las
    // propinas. Ahora el esperado las incluye — y se dice de dónde sale,
    // para que el número no parezca inventado.
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(conTarjeta);

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });
    await user.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    expect(screen.getByText(/Registrado = venta .*116\.000.* propina .*10\.741/)).toBeInTheDocument();
  });

  it("sin propinas de tarjeta no agrega la línea de composición", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(NO_CAUSE_REVIEW);

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });
    await user.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    expect(screen.queryByText(/Registrado = venta/)).not.toBeInTheDocument();
  });

  it("ofrece trasladar las comandas abiertas y lo manda al confirmar", async () => {
    // El backend ya sabía hacerlo (`transfer_open_orders`) y su propio
    // mensaje de error se lo pedía al operador — pero la pantalla mandaba
    // `false` fijo y no tenía la casilla en ninguna parte.
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue({ ...NO_CAUSE_REVIEW, open_orders: 3 });
    confirmCloseMock.mockResolvedValue({ to_deposit: 0, closes_day: false });

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });
    await user.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continuar/i }));

    const casilla = await screen.findByRole("checkbox", { name: /trasladar al turno siguiente las 3 comandas/i });
    await user.click(casilla);
    await user.click(screen.getByRole("button", { name: /confirmar cierre/i }));

    await waitFor(() => expect(confirmCloseMock).toHaveBeenCalledTimes(1));
    expect(confirmCloseMock.mock.calls[0]![2]).toMatchObject({ transfer_open_orders: true });
  });

  it("sin comandas abiertas no ofrece el traslado", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue({ ...NO_CAUSE_REVIEW, open_orders: 0 });

    const user = userEvent.setup();
    renderWithProviders(<CloseWizard shiftId={1} />, { me: { kind: "device", features: {} } });
    await user.click(screen.getByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continuar/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: /confirmar cierre/i })).toBeInTheDocument());
    expect(screen.queryByRole("checkbox", { name: /trasladar/i })).not.toBeInTheDocument();
  });
});
