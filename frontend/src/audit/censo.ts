/**
 * El censo de controles: qué puede tocar una persona en cada pantalla.
 *
 * Nace del pedido que abrió el rediseño del admin: «que no se pierdan
 * botones o acciones sólo porque no los tuvieron en cuenta en el diseño».
 * `docs/INVENTARIO-CONTROLES.md` los documenta en prosa —275 controles, 124
 * detrás de una condición— pero un documento no falla cuando alguien borra
 * un botón. Esto sí.
 *
 * Qué mide: por archivo, el conjunto de **rótulos visibles de controles**.
 * No mide que el control funcione ni que esté bien puesto: eso lo miden los
 * tests de pantalla. Mide lo único que un rediseño rompe en silencio, que es
 * que el control deje de existir.
 *
 * Es deliberadamente estático y tonto. Un extractor que renderice necesita
 * datos, sesión y flags encendidos, y son justamente los controles detrás de
 * una condición —los que más fácil se pierden— los que no se renderizan en
 * la pantalla feliz. Leer el código los ve a todos, incluido el que sólo
 * aparece cuando el servidor responde `PHOTO_REQUIRED`.
 */

/** Etiquetas cuyo texto interior es un rótulo que alguien lee y toca. */
const TAGS_DE_CONTROL =
  /<(Button|NavLink|Link|TabsTrigger|AlertDialogAction|AlertDialogCancel|DropdownMenuItem|SelectItem|ToggleGroupItem)\b[^>]*>([^<>{}]+)</g

/** `aria-label="…"`, `label="…"` y `label: "…"` — rótulos que no son texto interior. */
const ROTULOS_EN_ATRIBUTO = /(?:aria-label|label|title|placeholder)(?:=|:\s*)"([^"]+)"/g

/** Ruido que no es un control: una sola letra, un símbolo, una interpolación. */
function esRotuloUtil(texto: string): boolean {
  const limpio = texto.replace(/\s+/g, " ").trim()
  if (limpio.length < 3) return false
  if (/^[^\p{L}]+$/u.test(limpio)) return false // sin ninguna letra: «—», «·», «1»
  return true
}

/** Los rótulos de controles de UN archivo, únicos y ordenados. */
export function censarArchivo(fuente: string): string[] {
  const encontrados = new Set<string>()
  for (const patron of [TAGS_DE_CONTROL, ROTULOS_EN_ATRIBUTO]) {
    patron.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = patron.exec(fuente)) !== null) {
      const crudo = (m[2] ?? m[1] ?? "").replace(/\s+/g, " ").trim()
      if (esRotuloUtil(crudo)) encontrados.add(crudo)
    }
  }
  return [...encontrados].sort()
}

export type Censo = Record<string, string[]>

/**
 * Lo que desapareció de `antes` y no está en `ahora`, por archivo.
 *
 * La asimetría es a propósito: **agregar está bien, quitar no**. Un rediseño
 * suma controles, los reagrupa y los renombra; lo que no puede hacer es
 * dejarlos afuera sin que nadie se entere. Si un rótulo cambia de nombre a
 * propósito, se actualiza la base y el cambio queda a la vista en la
 * revisión, que es exactamente donde tiene que estar.
 */
export function perdidos(antes: Censo, ahora: Censo): Record<string, string[]> {
  const faltan: Record<string, string[]> = {}
  for (const [archivo, rotulos] of Object.entries(antes)) {
    const actuales = new Set(ahora[archivo] ?? [])
    const idos = rotulos.filter((r) => !actuales.has(r))
    if (idos.length > 0) faltan[archivo] = idos
  }
  return faltan
}
