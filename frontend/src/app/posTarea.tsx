import { createContext, useContext, useEffect } from "react";

/**
 * Lo que una pantalla del salón le pide a la cabecera unificada (`PosBarra`
 * en `PosLayout`, handoff `docs/diseno/handoff-pos-y-panel` § POS):
 *
 * - `titulo`: la pastilla de la tarea actual («Cobro · Mesa 4»).
 * - `sinSecciones`: la barra de secciones por rol se esconde (el cobro no la
 *   lleva: es una tarea con principio y fin, se sale con «← Comanda»).
 * - `aLoAncho`: la pantalla ocupa todo el alto disponible, sin el margen del
 *   layout, y maneja su propio desplazamiento (comanda y cobro en dos
 *   columnas con pie fijo).
 *
 * No decide nada de negocio: sólo presentación. Fuera de `PosLayout` (tests
 * de una pantalla suelta) el contexto no existe y el hook no hace nada.
 */
export interface PosTarea {
  titulo?: string | null;
  sinSecciones?: boolean;
  aLoAncho?: boolean;
}

export const PosTareaContext = createContext<((tarea: PosTarea | null) => void) | null>(null);

export function usePosTarea(tarea: PosTarea): void {
  const set = useContext(PosTareaContext);
  const { titulo = null, sinSecciones = false, aLoAncho = false } = tarea;
  useEffect(() => {
    if (!set) return;
    set({ titulo, sinSecciones, aLoAncho });
    return () => set(null);
  }, [set, titulo, sinSecciones, aLoAncho]);
}
