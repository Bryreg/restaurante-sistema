import { useEffect } from "react";

/**
 * Las dos densidades de la maqueta `m2b`: un solo sistema de color, dos
 * escalas. `salon` es la tablet compartida del salón (de pie, cuerpo 17 px,
 * objetivo táctil de 52 px); `oficina` es la PC del administrador (sentado,
 * cuerpo 14,5 px, filas de 34 px).
 *
 * Los valores viven en `src/index.css`; acá sólo se decide CUÁL aplica.
 */
export type Density = "salon" | "oficina";

const DENSITIES: readonly Density[] = ["salon", "oficina"];

/**
 * Pone la densidad en `<html>` mientras el layout esté montado.
 *
 * Va en la raíz del documento y no en el `<div>` del layout por dos razones,
 * las dos necesarias:
 *
 * 1. La escala se mueve desde el tamaño de letra de la raíz (`html.salon
 *    { font-size: 17px }`). Las utilidades de Tailwind están en `rem`, y `rem`
 *    se mide contra la raíz: puesta en un `<div>` no escalaría nada.
 * 2. Los diálogos, `Select`, `Sheet` y los avisos de `sonner` se montan por
 *    portal, colgados de `<body>`. Desde la raíz también los alcanza; desde el
 *    `<div>` del layout, no — y el diálogo que confirma un cobro en la tablet
 *    se dibujaría con la escala del escritorio.
 *
 * No cambia ningún comportamiento: sólo escribe una clase de presentación, y
 * la retira al desmontar para que al pasar de `/pos` a `/admin` no queden las
 * dos puestas.
 */
export function useDensity(density: Density): void {
  useEffect(() => {
    const root = document.documentElement;
    for (const value of DENSITIES) {
      root.classList.toggle(value, value === density);
    }
    return () => {
      root.classList.remove(density);
    };
  }, [density]);
}
