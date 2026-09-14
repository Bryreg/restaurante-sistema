import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { getMe, type Me } from "@/api/auth";

export interface SessionContextValue {
  me: Me | null;
  /** `true` sólo durante la primera carga; `refresh()` no la vuelve a poner en `true`. */
  loading: boolean;
  refresh: () => Promise<void>;
  hasFeature: (key: string) => boolean;
}

/**
 * Exportado (no sólo `useSession`) para que `src/test/utils.tsx` pueda
 * inyectar un `me` fijo sin pasar por `getMe()` — así los tests no dependen
 * de una API real corriendo.
 */
export const SessionContext = createContext<SessionContextValue | null>(null);

/**
 * Envuelve toda la app. Carga `GET /auth/me` una vez al montar y cada vez
 * que algo dispara `"session:expired"` (un `401` de `src/api/client.ts`) la
 * limpia, para que los guards de `router.tsx` redirijan a `/login` o
 * `/pos/activate` sin que cada pantalla revise códigos de estado.
 */
export function SessionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const next = await getMe();
      setMe(next);
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onExpired = () => setMe(null);
    window.addEventListener("session:expired", onExpired);
    return () => window.removeEventListener("session:expired", onExpired);
  }, []);

  const hasFeature = useCallback((key: string) => Boolean(me?.features?.[key]), [me]);

  const value = useMemo<SessionContextValue>(
    () => ({ me, loading, refresh, hasFeature }),
    [me, loading, refresh, hasFeature],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession() se usa dentro de <SessionProvider>");
  }
  return ctx;
}
