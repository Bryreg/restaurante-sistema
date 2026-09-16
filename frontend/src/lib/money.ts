/**
 * Dinero en enteros de pesos colombianos (COP). Nunca flotantes, nunca
 * derivado en el frontend: el backend es la única matemática (AGENTS.md,
 * SPEC-NEGOCIO §11.13). `null`/`undefined` NUNCA se muestran como "0": se
 * muestran como "—" porque significan "no aplica" o "todavía no calculado".
 */

/** Denominaciones de billetes y monedas COP vigentes (`backend/app/core/money.py`). */
export const DENOMINATIONS: readonly number[] = [
  50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000,
];

const COP_FORMATTER = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  currencyDisplay: "symbol",
  maximumFractionDigits: 0,
  minimumFractionDigits: 0,
});

/**
 * Formatea un entero de pesos como "$ 1.234.567". `null` o `undefined`
 * devuelven "—" (nunca "$ 0": esa cifra existe y es distinta de "sin dato").
 */
export function formatCOP(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  return COP_FORMATTER.format(value).replace(/ /g, " ");
}

/**
 * Formatea un costo por unidad base (`$/g`, `$/ml`, `$/unidad`) que llega
 * como texto decimal, conservando TODOS los decimales significativos que
 * mandó el backend. Distinto de `formatCOP`, que redondea al peso: los
 * precios de venta son enteros de pesos, pero el costo de un insumo NO lo es
 * (la sal cuesta "0.003"/g, la pechuga "14.5"/g), y `formatCOP` con
 * `maximumFractionDigits: 0` convertía a "$ 0" y "$ 15" — el cliente
 * decidiendo una cifra de plata que el servidor no mandó (B-2, ronda 2 de
 * `features/fase-2-costo-inventario`).
 *
 * Trabaja sobre el string: separa entera/decimal a mano, sin pasar por
 * `Number()` para decidir la precisión y sin multiplicar ni dividir por
 * ninguna escala (el invariante de `src/audit/inventory.test.ts` prohíbe
 * `/1000`/`COST_SCALE` en este territorio).
 *
 * Cuando la parte entera es "0" con decimales no nulos (`"0.003"`), se omite
 * ese cero — mostrarlo ("$ 0,003") repite, en los dos primeros caracteres
 * visibles, el mismo patrón "$ 0" del cero mudo que esta función corrige;
 * omitirlo no pierde ni un decimal y es un formato real y usado (p.ej.
 * "$.05" en cotizaciones financieras) para costos menores a la unidad.
 */
export function formatCOPDecimal(value: string | number | null): string {
  if (value === null) return "—";
  const raw = typeof value === "number" ? value.toString() : value.trim();
  if (raw === "") return "—";

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [integerRaw = "0", decimalRaw = ""] = unsigned.split(".");

  // Sólo dígitos (defensivo ante texto inesperado); nunca menos de un "0".
  const decimals = decimalRaw.replace(/\D/g, "");
  let integer = integerRaw.replace(/\D/g, "") || "0";
  integer = integer.replace(/^0+(?=\d)/, ""); // sin ceros a la izquierda sobrantes ("007" -> "7")

  const decimalsAreZero = decimals === "" || /^0+$/.test(decimals);
  const sign = negative ? "-" : "";

  if (integer === "0" && !decimalsAreZero) {
    return `${sign}$ ,${decimals}`;
  }

  let grouped = "";
  for (let i = 0; i < integer.length; i++) {
    if (i > 0 && (integer.length - i) % 3 === 0) grouped += ".";
    grouped += integer[i];
  }

  return decimals ? `${sign}$ ${grouped},${decimals}` : `${sign}$ ${grouped}`;
}

/**
 * Convierte lo que teclea una persona ("1.234.567", "1234567,00", "$ 1000")
 * a un entero de pesos, o `null` si no hay nada que interpretar. Redondea al
 * peso: nunca se guardan centavos.
 */
export function parseCOP(input: string | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // Quita separador de miles (punto), símbolo de moneda y espacios; una coma
  // se interpreta como separador decimal colombiano y se descarta la parte
  // decimal (el peso no tiene fracción en este sistema).
  const withoutCurrency = trimmed.replace(/[^\d.,-]/g, "");
  const withoutThousands = withoutCurrency.replace(/\.(?=\d{3}(?:\D|$))/g, "");
  const normalized = withoutThousands.split(",")[0];
  if (normalized === "" || normalized === "-") return null;
  const parsed = Number(normalized);
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed);
}
