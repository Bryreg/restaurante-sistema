import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Me } from "@/api/auth";
import { ApiError } from "@/api/client";
import type { ShiftTips } from "@/api/shifts";
import { SessionContext, type SessionContextValue } from "@/app/session";

import { SingleStepCloseForm } from "../SingleStepCloseForm";

const { closeSingleStepMock, getShiftTipsMock } = vi.hoisted(() => ({
  closeSingleStepMock: vi.fn(),
  getShiftTipsMock: vi.fn(),
}));

vi.mock("@/api/shifts", async () => {
  const actual = await vi.importActual<typeof import("@/api/shifts")>("@/api/shifts");
  return {
    ...actual,
    closeSingleStep: closeSingleStepMock,
    getShiftTips: getShiftTipsMock,
  };
});

/**
 * `renderWithProviders` (de `@/test/utils`, territorio de `frontend-core`)
 * fija `refresh: async () => {}` sin exponer un mock espiable, así que este
 * archivo arma su propio árbol de providers — mismo patrón (QueryClient +
 * MemoryRouter + SessionContext), pero con un `refresh` que sí se puede
 * comprobar. No se tocó `src/test/utils.tsx`.
 */
function renderWithRefreshSpy(ui: React.ReactElement, refresh: () => Promise<void>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const me: Me = { kind: "device", features: { "cash.blind_close": false } };
  const sessionValue: SessionContextValue = {
    me,
    loading: false,
    refresh,
    hasFeature: (key: string) => Boolean(me.features?.[key]),
  };
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/pos/turno"]}>
        <SessionContext.Provider value={sessionValue}>{ui}</SessionContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Iteración 2 (ajuste del Maestro): una tablet con flags viejos puede
 * mandar `POST /shifts/{id}/close` aunque la sede ya tenga
 * `cash.blind_close` encendida. El servidor responde `400
 * BLIND_CLOSE_REQUIRED` — acá NO se reintenta el POST, se muestra el
 * mensaje y se dispara la actualización de flags (`refresh()` de
 * `useSession()`, que vuelve a pedir `GET /auth/me`) para que `ShiftPage`
 * pueda cambiar al wizard.
 */
describe("SingleStepCloseForm — 400 BLIND_CLOSE_REQUIRED", () => {
  beforeEach(() => {
    getShiftTipsMock.mockReset().mockResolvedValue({ cash_out: 9_876 } satisfies ShiftTips);
  });

  it("no reintenta /close, muestra el mensaje del servidor y refresca los flags", async () => {
    closeSingleStepMock.mockRejectedValueOnce(
      new ApiError(400, "BLIND_CLOSE_REQUIRED", "Esta sede exige el cierre a ciegas en tres pasos.", {
        feature: "cash.blind_close",
      }),
    );
    const refresh = vi.fn().mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderWithRefreshSpy(<SingleStepCloseForm shiftId={1} />, refresh);

    await user.click(screen.getByRole("button", { name: /cerrar turno/i }));

    await waitFor(() =>
      expect(screen.getByText("Esta sede exige el cierre a ciegas en tres pasos.")).toBeInTheDocument(),
    );
    expect(closeSingleStepMock).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);

    // No hay reintento automático: esperar un tick más no dispara un segundo POST.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(closeSingleStepMock).toHaveBeenCalledTimes(1);
  });
});

describe("SingleStepCloseForm — iteración 3 (H-8)", () => {
  beforeEach(() => {
    getShiftTipsMock.mockReset().mockResolvedValue({ cash_out: 9_876 } satisfies ShiftTips);
  });

  it("pinta el cash_out de GET /shifts/{id}/tips como referencia, sin recalcularlo", async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    renderWithRefreshSpy(<SingleStepCloseForm shiftId={1} />, refresh);

    await waitFor(() => expect(getShiftTipsMock).toHaveBeenCalledWith(1));
    // El monto que llega de `cash_out` se pinta tal cual (formatCOP de 9.876), no recalculado.
    await waitFor(() => expect(screen.getByText(/9\.876/)).toBeInTheDocument());
    // El rótulo deja claro que es una referencia, no un dato que se use para calcular nada.
    expect(screen.getByText(/Referencia del sistema/)).toBeInTheDocument();
  });
});
