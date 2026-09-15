/**
 * La ÚNICA suma que hace el frontend en el cobro: lo tecleado en los
 * `splits` de la tabla de pagos, para decir "faltan $X" como guía de tecleo
 * mientras se arma el pago. El servidor es quien de verdad valida el total
 * (`400 SPLITS_DO_NOT_MATCH`); este número nunca decide nada, sólo ayuda a
 * teclear (CONTRATO-INTERNO-1b-1.md §6.1, "una sola matemática, en el
 * backend").
 */
export function sumTyped(splits: { amount: number | null }[]): number {
  return splits.reduce((acc, split) => acc + (split.amount ?? 0), 0);
}
