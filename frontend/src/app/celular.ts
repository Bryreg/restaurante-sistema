import { useSyncExternalStore } from "react";

/** El mismo corte que `md:` de Tailwind: por debajo de 768 px es el celular. */
export const CONSULTA_CELULAR = "(max-width: 767.98px)";

function suscribirCelular(avisar: () => void): () => void {
  if (typeof window.matchMedia !== "function") return () => {};
  const consulta = window.matchMedia(CONSULTA_CELULAR);
  consulta.addEventListener("change", avisar);
  return () => consulta.removeEventListener("change", avisar);
}

function esCelular(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(CONSULTA_CELULAR).matches;
}

/**
 * **Lo del celular se monta sólo en el celular**, no se esconde con CSS nada
 * más. Con `md:hidden` solo, el escritorio llevaría en el árbol una segunda
 * «Hoy» y una segunda «Ventas» invisibles, y cada `getByRole("link", { name:
 * "Hoy" })` de las pruebas —y cada lector de pantalla que no respete
 * `display` de algún ancestro— vería dos. Sin `matchMedia` (jsdom) es
 * escritorio: nada cambia.
 *
 * Lo usan la barra inferior (`AdminLayout.tsx`), Hoy en el celular y las
 * pantallas móviles de Caja, Equipo e Informes.
 */
export function useEsCelular(): boolean {
  return useSyncExternalStore(suscribirCelular, esCelular, () => false);
}
