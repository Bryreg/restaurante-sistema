import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";

import type { Me } from "@/api/auth";
import { SessionContext, type SessionContextValue } from "@/app/session";

export interface RenderWithProvidersOptions {
  /** `null` simula "sin sesión" (por defecto). */
  me?: Me | null;
  /** Un objeto para llegar con `state` de navegación, como tras un `navigate(…, { state })`. */
  route?: string | { pathname: string; state?: unknown };
  /**
   * Reemplaza partes del valor de sesión — p. ej. un `clear` espía, para
   * comprobar que una pantalla sólo olvida la sesión cuando el servidor ya
   * la cerró.
   */
  session?: Partial<SessionContextValue>;
}

function buildSessionValue(
  me: Me | null,
  overrides: Partial<SessionContextValue>,
): SessionContextValue {
  return {
    me,
    loading: false,
    refresh: async () => {},
    clear: () => {},
    hasFeature: (key: string) => Boolean(me?.features?.[key]),
    ...overrides,
  };
}

/**
 * Envuelve `ui` con `QueryClientProvider` + `SessionProvider` (con `me`
 * inyectado, sin llamar a `GET /auth/me`) + `MemoryRouter` — contrato
 * interno § 5.
 */
export function renderWithProviders(
  ui: ReactElement,
  { me = null, route = "/", session = {} }: RenderWithProvidersOptions = {},
): RenderResult {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <SessionContext.Provider value={buildSessionValue(me, session)}>
          {ui}
        </SessionContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Un `Me` de organización admin con overrides puntuales, para tests. */
export function buildMe(overrides: Partial<Me> = {}): Me {
  return {
    kind: "admin",
    user: { id: 1, name: "Admin de prueba", role: "admin" },
    organization: { id: 1, name: "Organización de prueba" },
    features: {},
    ...overrides,
  };
}
