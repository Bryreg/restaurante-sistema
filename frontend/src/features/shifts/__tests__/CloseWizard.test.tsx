import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/api/client";
import type { CloseCountResult, CloseReview } from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import { CloseWizard } from "../CloseWizard";

const { closeCountMock, getCloseReviewMock, confirmCloseMock } = vi.hoisted(() => ({
  closeCountMock: vi.fn(),
  getCloseReviewMock: vi.fn(),
  confirmCloseMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    closeCount: closeCountMock,
    getCloseReview: getCloseReviewMock,
    confirmClose: confirmCloseMock,
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
