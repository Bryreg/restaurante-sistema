/**
 * La escala del eje de una gráfica: dónde van las líneas de guía y cómo se
 * rotulan. **No es plata**: son las marcas de la regla contra la que se
 * dibujan las barras.
 *
 * Vive en su propio archivo, y no adentro de `charts.tsx`, porque el guardián
 * `ninguna pantalla nueva redondea plata` (`audit/fiscal.test.ts`) tiene que
 * seguir cuidando el resto del archivo. La excepción se nombra acá y abarca
 * treinta líneas, no un módulo entero de gráficas donde mañana alguien sí
 * podría derivar un saldo sin que nadie se entere.
 *
 * Lo que hace y lo que NO hace:
 *
 * - **Hace**: elegir cuatro cortes «redondos» por encima del máximo de la
 *   serie, y escribirlos como «$200k». Eso es tipografía de eje.
 * - **NO hace**: cambiar, sumar, promediar ni redondear ninguna cifra que se
 *   muestre como plata. Las barras se dibujan con los enteros que mandó el
 *   servidor, y toda cifra que se lee como pesos pasa por `formatCOP` sobre
 *   ese mismo entero, sin tocar.
 */

/**
 * Cinco cortes —el cero y cuatro más— que cubren `max`, en pasos de 1, 2 o 5
 * por una potencia de diez. Es lo que hace que el eje diga «0 · 200k · 400k»
 * y no «0 · 187k · 374k»: nadie lee un eje con cifras que no diría en voz
 * alta.
 */
export function cortesDeEje(max: number): number[] {
  const paso = Math.max(1, Math.ceil(max / 4));
  const magnitud = 10 ** Math.floor(Math.log10(paso));
  const norm = paso / magnitud;
  const bonito = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitud;
  return [0, 1, 2, 3, 4].map((i) => i * bonito);
}

/**
 * El rótulo de un corte: «0», «$200k», «$1,2M». Abreviado a propósito — el
 * eje se lee de reojo y «$ 200.000» cinco veces apiladas tapa la gráfica. La
 * cifra exacta de cada barra vive en la tabla de la pantalla, que es la
 * alternativa accesible completa.
 *
 * **Lleva el signo de pesos** (`a2`: «$800k»). Sin él, un eje de plata y uno
 * de cantidad de comandas se leen igual, y quien mira de lejos no sabe si la
 * barra de las ocho vale ochocientos mil o ochocientas comandas.
 */
export function rotuloDeCorte(valor: number): string {
  if (valor === 0) return "0";
  if (valor >= 1_000_000) {
    const millones = valor / 1_000_000;
    // Coma decimal: es el separador de es-CO, y el punto acá se leería como
    // separador de miles.
    return `$${millones % 1 === 0 ? millones : millones.toFixed(1).replace(".", ",")}M`;
  }
  return `$${Math.round(valor / 1000)}k`;
}
