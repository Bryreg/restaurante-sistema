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
