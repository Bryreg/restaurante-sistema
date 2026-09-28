import { useSyncExternalStore } from "react";

/**
 * `true` mientras la consulta de medios se cumple. Sin `matchMedia` (jsdom en
 * los tests) es siempre `false`: la pantalla se dibuja en su forma por
 * defecto, que es la vertical.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const consulta = window.matchMedia(query);
      consulta.addEventListener("change", onChange);
      return () => consulta.removeEventListener("change", onChange);
    },
    () => typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}

/** La tablet apaisada (1280 × 800): las pantallas del salón pasan a su variante horizontal. */
export const TABLET_HORIZONTAL = "(orientation: landscape) and (min-width: 1024px)";
