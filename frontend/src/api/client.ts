/**
 * Cliente HTTP único. Toda llamada al backend pasa por `api()`: mismo
 * origen (`/api/v1`, la cookie viaja sola vía el proxy de Vite en
 * desarrollo), JSON de punta a punta, y un solo lugar donde un error del
 * servidor se convierte en `ApiError` con la forma
 * `{ code, message }` que define `features/fase-1a-cimientos/spec.md`.
 *
 * Nunca se guarda nada de sesión acá (ni token ni cookie leída a mano): la
 * sesión vive en la cookie `httpOnly` que pone el servidor (AGENTS.md).
 */

const API_BASE = "/api/v1";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ApiErrorShape {
  code: string;
  message: string;
  [key: string]: unknown;
}

/**
 * Error tipado que representa exactamente `{ error: { code, message, ... } }`
 * — la única forma de error de negocio del backend (AGENTS.md, spec § API
 * contract). `status` es el código HTTP; `extra` son los campos adicionales
 * que el backend puede agregar (p. ej. `{feature: "..."}` en
 * `FEATURE_DISABLED`).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown>;

  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface ApiOptions {
  method?: HttpMethod;
  body?: unknown;
  /** Se manda como encabezado `Idempotency-Key` (caja, spec § convenciones). */
  idempotencyKey?: string;
  /** Parámetros de query string; los valores `null`/`undefined` se omiten. */
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

/** `crypto.randomUUID()` — una clave nueva por cada escritura de caja. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function buildUrl(path: string, query?: ApiOptions["query"]): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${API_BASE}${normalizedPath}`, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.pathname + url.search;
}

async function parseErrorBody(response: Response): Promise<ApiErrorShape> {
  try {
    const data = await response.json();
    const error = data?.error;
    if (error && typeof error === "object" && typeof error.code === "string" && typeof error.message === "string") {
      return error as ApiErrorShape;
    }
  } catch {
    // el cuerpo no era JSON (p. ej. un 502 de un proxy) — cae al mensaje genérico
  }
  return {
    code: "UNKNOWN_ERROR",
    message: `Error del servidor (${response.status}). Intentá de nuevo.`,
  };
}

/**
 * `window` dispara `"session:expired"` ante cualquier `401`, para que
 * `SessionProvider` limpie `me` y redirija a `/login` o `/pos/activate` sin
 * que cada pantalla tenga que revisar el código de estado.
 */
function notifySessionExpired(): void {
  window.dispatchEvent(new CustomEvent("session:expired"));
}

/** `401 IDENTIFY_REQUIRED`: hace falta una persona, no volver a activar el dispositivo. */
function notifyIdentifyRequired(): void {
  window.dispatchEvent(new CustomEvent("session:identify-required"));
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { method = "GET", body, idempotencyKey, query, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey;
  }

  const response = await fetch(buildUrl(path, query), {
    method,
    headers,
    credentials: "include",
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const { code, message, ...extra } = await parseErrorBody(response);
    if (response.status === 401 && code === "IDENTIFY_REQUIRED") {
      // El DISPOSITIVO sigue activado: lo que venció es la persona. Tratarlo
      // como sesión vencida borraba `me` y mandaba la tablet a «Activar
      // dispositivo» (que pide el PIN de sede). `SessionProvider` vuelve a
      // leer `GET /auth/me` y cada pantalla decide qué hacer sin persona.
      notifyIdentifyRequired();
    } else if (response.status === 401) {
      notifySessionExpired();
    }
    throw new ApiError(response.status, code, message, extra);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return undefined as T;
  }
  return (await response.json()) as T;
}
