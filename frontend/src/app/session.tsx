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
  /**
   * Olvida la sesión del lado del cliente para que los guards de
   * `router.tsx` redirijan ya mismo. **La cookie la borra el servidor**: esto
   * se llama DESPUÉS de que `POST /auth/logout` o `/auth/device/deactivate`
   * respondieron bien, nunca antes. Limpiar acá con la cookie todavía viva
   * deja a la persona «afuera» hasta que recarga y vuelve a entrar sola, que
   * es peor que no haber salido.
   */
  clear: () => void;
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

  const clear = useCallback(() => setMe(null), []);

  useEffect(() => {
    const onExpired = () => setMe(null);
    // Venció la PERSONA, no el dispositivo: se relee `me` (llega sin
    // `employee`) y `PosLayout` manda a «Quién opera» — salvo el KDS, que
    // es una pantalla de estación y pide el PIN sólo al marcar algo.
    const onIdentifyRequired = () => void refresh();
    window.addEventListener("session:expired", onExpired);
    window.addEventListener("session:identify-required", onIdentifyRequired);
    return () => {
      window.removeEventListener("session:expired", onExpired);
      window.removeEventListener("session:identify-required", onIdentifyRequired);
    };
  }, [refresh]);

  const hasFeature = useCallback((key: string) => Boolean(me?.features?.[key]), [me]);

  const value = useMemo<SessionContextValue>(
    () => ({ me, loading, refresh, clear, hasFeature }),
    [me, loading, refresh, clear, hasFeature],
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
