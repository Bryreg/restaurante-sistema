import { useCallback, useEffect, useState } from "react";

/**
 * Pantalla del salón: clara u oscura, elegida POR DISPOSITIVO.
 *
 * La propuesta «Un solo libro, dos mesas» ponía el salón siempre en pizarra
 * oscura. Eso sirve en un bar o en un servicio de noche con luz baja, pero en
 * un restaurante de almuerzo con luz de día, ventanales o terraza la pantalla
 * oscura refleja más y la letra clara sobre fondo oscuro se lee peor. Por eso:
 *
 * - el salón arranca CLARO (mismo contraste alto y objetivos de 56 px);
 * - cada tablet puede pasarse a oscuro con un toque, y lo recuerda (la de la
 *   terraza queda clara, la del bar oscura);
 * - la COCINA (KDS) va siempre en pizarra: pantalla fija, mirada de lejos,
 *   con los tiquetes claros encima (`useCocinaPantalla`).
 *
 * Se guarda en `localStorage`, como el claro/oscuro del admin: es una
 * preferencia de presentación del dispositivo, nada sensible.
 */
export type SalonTheme = "claro" | "oscuro";

const KEY = "salon-pantalla";

function leer(): SalonTheme {
  try {
    return localStorage.getItem(KEY) === "oscuro" ? "oscuro" : "claro";
  } catch {
    return "claro";
  }
}

export function useSalonTheme(): [SalonTheme, (tema: SalonTheme) => void] {
  const [tema, setTema] = useState<SalonTheme>(leer);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("salon-oscuro", tema === "oscuro");
    return () => {
      root.classList.remove("salon-oscuro");
    };
  }, [tema]);

  const cambiar = useCallback((nuevo: SalonTheme) => {
    try {
      localStorage.setItem(KEY, nuevo);
    } catch {
      // Sin almacenamiento (modo privado): la elección dura lo que dure la pestaña.
    }
    setTema(nuevo);
  }, []);

  return [tema, cambiar];
}

/** Mientras la pantalla de cocina está abierta, la pizarra manda. */
export function useCocinaPantalla(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("cocina");
    return () => {
      root.classList.remove("cocina");
    };
  }, []);
}
