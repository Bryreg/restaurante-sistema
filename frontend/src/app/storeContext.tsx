import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { listStores, type StoreOut } from "@/api/stores";

import { useSession } from "./session";

/**
 * Sede activa en Admin (no confundir con la sede del dispositivo en POS,
 * que ya viene fijada por la cookie del servidor). Sólo se muestra un
 * selector cuando `multi_store` está encendida (`AdminLayout.tsx`), pero
 * casi toda pantalla de Configuración necesita un `store_id` aunque la
 * organización tenga una sola sede.
 */
interface StoreSelectionValue {
  stores: StoreOut[];
  loading: boolean;
  activeStoreId: number | null;
  setActiveStoreId: (id: number) => void;
}

const StoreSelectionContext = createContext<StoreSelectionValue | null>(null);

export function StoreSelectionProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const { me } = useSession();
  const [stores, setStores] = useState<StoreOut[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeStoreId, setActiveStoreId] = useState<number | null>(null);

  useEffect(() => {
    if (me?.kind !== "admin") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    listStores()
      .then((rows) => {
        if (cancelled) return;
        setStores(rows);
        setActiveStoreId((prev) => prev ?? rows[0]?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setStores([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [me?.kind]);

  const value = useMemo<StoreSelectionValue>(
    () => ({ stores, loading, activeStoreId, setActiveStoreId }),
    [stores, loading, activeStoreId],
  );

  return <StoreSelectionContext.Provider value={value}>{children}</StoreSelectionContext.Provider>;
}

const NOOP_STORE_SELECTION: StoreSelectionValue = {
  stores: [],
  loading: false,
  activeStoreId: null,
  setActiveStoreId: () => {},
};

/**
 * Fuera de `<StoreSelectionProvider>` (p. ej. una pantalla renderizada
 * sola en un test) devuelve un valor neutro en vez de lanzar, para que un
 * componente que sólo usa la sede activa como dato opcional no obligue a
 * todos sus tests a levantar el árbol completo de Admin.
 */
export function useStoreSelection(): StoreSelectionValue {
  return useContext(StoreSelectionContext) ?? NOOP_STORE_SELECTION;
}
