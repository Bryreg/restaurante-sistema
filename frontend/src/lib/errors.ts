/**
 * Convierte cualquier error atrapado (típicamente un `ApiError` de
 * `src/api/client.ts`, pero también errores de red o de React Query) en un
 * texto legible para mostrar en pantalla. Nunca se renderiza un objeto
 * directamente (la referencia dejó una pantalla blanca cuando `detail` era
 * una lista: SPEC-NEGOCIO § 12).
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) {
    return err.message;
  }
  if (typeof err === "string" && err.trim() !== "") {
    return err;
  }
  if (
    err !== null &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message?: unknown }).message === "string" &&
    (err as { message: string }).message.trim() !== ""
  ) {
    return (err as { message: string }).message;
  }
  return "Ocurrió un error inesperado. Intentá de nuevo.";
}
