import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import type {
  CloseConfirmResult,
  CloseCountResult,
  CloseReview,
  ShiftCurrent,
  ShiftSummary,
  ShiftTips,
  SingleStepCloseResult,
} from "@/api/shifts";
import { renderWithProviders } from "@/test/utils";

import ShiftPage from "../ShiftPage";

/**
 * Regresión del defecto: **la pantalla final del cierre era inalcanzable**.
 *
 * Confirmar el cierre invalida `CURRENT_SHIFT_QUERY_KEY`; el refetch trae
 * `null` y el `if (!shift) return <OpenShiftForm />` de `ShiftPage`
 * desmontaba el formulario con su pantalla de «Turno cerrado» adentro. Quien
 * cerraba la caja nunca alcanzaba a leer **cuánto tenía que consignar** — la
 * plata que sale del cajón para el banco.
 *
 * El centinela de los dos tests es el botón «Abrir turno»: aparece
 * únicamente cuando la consulta del turno YA devolvió `null` **y ya se
 * pintó**. Sirve igual en las dos versiones del código (con el defecto es el
 * botón de `OpenShiftForm`; arreglado es el de continuar de la pantalla de
 * resultado), así que la aserción de «A consignar» se hace siempre después
 * de que el turno desapareció de verdad, y no en la ventana de carrera en
 * que el refetch todavía no llegó.
 */

const { estado, SHIFT, SUMMARY } = vi.hoisted(() => ({
  // `turnoAbierto` se apaga en cuanto el servidor confirma el cierre: a
  // partir de ahí `GET /shifts/current` devuelve `null`, que es exactamente
  // lo que pasa contra el backend real.
  estado: { turnoAbierto: true },
  SHIFT: {
    id: 42,
    business_date: "2026-09-14",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    roster: [],
    is_stale: false,
    cash_over_threshold: false,
  } satisfies ShiftCurrent,
  SUMMARY: {
    id: 42,
    business_date: "2026-09-14",
    status: "open",
    opened_at: "2026-09-14T13:00:00Z",
    cash_responsible: { id: 1, name: "Ana" },
    opening_cash_total: 200_000,
    roster: [],
    movements: [],
    swaps: [],
    pickups: [],
    handovers: [],
  } satisfies ShiftSummary,
}));

const {
  getCurrentShiftMock,
  getShiftSummaryMock,
  closeCountMock,
  getCloseReviewMock,
  confirmCloseMock,
  closeSingleStepMock,
  getShiftTipsMock,
} = vi.hoisted(() => ({
  getCurrentShiftMock: vi.fn(),
  getShiftSummaryMock: vi.fn(),
  closeCountMock: vi.fn(),
  getCloseReviewMock: vi.fn(),
  confirmCloseMock: vi.fn(),
  closeSingleStepMock: vi.fn(),
  getShiftTipsMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    getCurrentShift: getCurrentShiftMock,
    getShiftSummary: getShiftSummaryMock,
    closeCount: closeCountMock,
    getCloseReview: getCloseReviewMock,
    confirmClose: confirmCloseMock,
    closeSingleStep: closeSingleStepMock,
    getShiftTips: getShiftTipsMock,
  };
});

/** Diferencia 0: no exige causa, así no hace falta abrir un `<Select>`. */
const REVIEW_SIN_CAUSA: CloseReview = {
  count_id: 7,
  expected: 250_000,
  difference: 0,
  equation: { base: 200_000, cash_sales: 60_000, incomes: 0, expenses: 10_000, pickups: 0 },
  card: { registered: 0, counted: 0, difference: 0 },
  transfer: { registered: 0, counted: 0, difference: 0 },
  requires_cause: false,
  requires_identified_cause: false,
  is_critical: false,
  closes_day_suggested: false,
};

/** Una cifra que no puede confundirse con ninguna otra de la pantalla. */
const A_CONSIGNAR = 1_234_500;
const A_CONSIGNAR_TEXTO = /1\.234\.500/;

function deviceMe(features: Record<string, boolean>): Me {
  return {
    kind: "device",
    store: { id: 1, name: "Sede Centro", cutoff_hour: 6, active_channels: [] },
    employee: { id: 1, name: "Ana", role: "operator", can_charge: false },
    employee_expires_at: null,
    organization: { id: 1, name: "Organización de prueba" },
    features,
  };
}

/** El renglón entero de «A consignar», para leer rótulo y cifra juntos. */
function renglonAConsignar(): HTMLElement {
  return screen.getByText("A consignar").closest("div") as HTMLElement;
}

describe("ShiftPage — la pantalla de «Turno cerrado» sobrevive a que el turno pase a null", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    estado.turnoAbierto = true;
    getCurrentShiftMock.mockImplementation(async () => (estado.turnoAbierto ? SHIFT : null));
    getShiftSummaryMock.mockResolvedValue(SUMMARY);
    getShiftTipsMock.mockResolvedValue({ cash_out: 0 } satisfies ShiftTips);
  });

  it("CloseWizard (cash.blind_close encendida): «A consignar» y su cifra siguen en pantalla", async () => {
    closeCountMock.mockResolvedValueOnce({ count_id: 7 } satisfies CloseCountResult);
    getCloseReviewMock.mockResolvedValue(REVIEW_SIN_CAUSA);
    confirmCloseMock.mockImplementation(async () => {
      // El turno deja de existir en el servidor, como en el cierre real.
      estado.turnoAbierto = false;
      return { to_deposit: A_CONSIGNAR, closes_day: true } satisfies CloseConfirmResult;
    });

    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "cash.blind_close": true }) });

    await user.click(await screen.findByRole("tab", { name: "Cierre" }));

    // Paso 1 → 2 → 3 → confirmar.
    await user.click(await screen.findByRole("button", { name: /continuar/i }));
    await waitFor(() => expect(screen.getByText(/^esperado$/i)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /continuar/i }));
    await user.click(await screen.findByRole("button", { name: /confirmar cierre/i }));

    await waitFor(() => expect(confirmCloseMock).toHaveBeenCalledTimes(1));

    // CENTINELA: sólo aparece cuando `GET /shifts/current` ya devolvió
    // `null` y ese estado ya se pintó. Antes del arreglo, acá el asistente
    // ya había sido reemplazado por `OpenShiftForm`.
    await screen.findByRole("button", { name: "Abrir turno" });

    // Lo que el defecto se llevaba: el rótulo y la plata que hay que llevar
    // al banco, todavía a la vista después de que el turno desapareció.
    expect(screen.getByText("A consignar")).toBeInTheDocument();
    expect(renglonAConsignar().textContent).toMatch(A_CONSIGNAR_TEXTO);
    expect(screen.getByText(/Este cierre también cerró el día operativo/i)).toBeInTheDocument();

    // Y la invalidación siguió ocurriendo: el turno se volvió a consultar
    // después del cierre y ya no existe.
    await waitFor(() => expect(getCurrentShiftMock.mock.results.length).toBeGreaterThan(1));
    await expect(getCurrentShiftMock.mock.results.at(-1)?.value).resolves.toBeNull();
  });

  it("SingleStepCloseForm (cash.blind_close apagada): «A consignar» y su cifra siguen en pantalla", async () => {
    closeSingleStepMock.mockImplementation(async () => {
      estado.turnoAbierto = false;
      return {
        to_deposit: A_CONSIGNAR,
        closes_day: false,
        expected: 250_000,
        difference: 0,
      } satisfies SingleStepCloseResult;
    });

    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "cash.blind_close": false }) });

    await user.click(await screen.findByRole("tab", { name: "Cierre" }));
    await user.click(await screen.findByRole("button", { name: /cerrar turno/i }));

    await waitFor(() => expect(closeSingleStepMock).toHaveBeenCalledTimes(1));

    await screen.findByRole("button", { name: "Abrir turno" });

    expect(screen.getByText("A consignar")).toBeInTheDocument();
    expect(renglonAConsignar().textContent).toMatch(A_CONSIGNAR_TEXTO);
  });

  it("la pantalla de resultado no se va sola: sólo la borra la acción explícita", async () => {
    closeSingleStepMock.mockImplementation(async () => {
      estado.turnoAbierto = false;
      return { to_deposit: A_CONSIGNAR, closes_day: false } satisfies SingleStepCloseResult;
    });

    const user = userEvent.setup();
    renderWithProviders(<ShiftPage />, { me: deviceMe({ "cash.blind_close": false }) });

    await user.click(await screen.findByRole("tab", { name: "Cierre" }));
    await user.click(await screen.findByRole("button", { name: /cerrar turno/i }));

    const continuar = await screen.findByRole("button", { name: "Abrir turno" });

    // El turno ya devolvió `null` y la cifra sigue ahí; dejar correr el
    // reloj un rato más no se la lleva por delante. Es el «parpadeo» del
    // defecto original: ahí la pantalla se iba sola, sin que nadie tocara
    // nada.
    await new Promise((listo) => setTimeout(listo, 400));
    expect(renglonAConsignar().textContent).toMatch(A_CONSIGNAR_TEXTO);

    // Recién al tocar la acción explícita se limpia y aparece el formulario
    // de abrir turno (su título, que la pantalla de resultado no tiene).
    await user.click(continuar);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Abrir turno" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("A consignar")).not.toBeInTheDocument();
  });
});
