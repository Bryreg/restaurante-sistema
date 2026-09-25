/**
 * **La foto se achica en la tablet antes de mandarla.** Una foto de cámara
 * pesa 2–4 MB; mandada tal cual, el pedido tarda en una red de restaurante y
 * el servidor tiene que guardar megas por cada retiro. Achicada al lado más
 * largo de 1600 px en JPEG queda en ~200 KB y se sigue leyendo un
 * comprobante o un billete.
 *
 * Si el navegador no puede achicarla (sin `canvas`, como en las pruebas, o
 * una imagen que no se deja decodificar), se manda la original: el servidor
 * acepta hasta 4 MB. Achicar es una mejora, nunca una razón para perder la
 * foto.
 */

/** El lado más largo, en píxeles, de la foto que se manda. */
export const LADO_MAXIMO = 1600
const CALIDAD_JPEG = 0.8

export function leerComoDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer la foto"))
    reader.readAsDataURL(file)
  })
}

async function achicar(file: File): Promise<string | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null
  const bitmap = await createImageBitmap(file)
  try {
    const escala = Math.min(1, LADO_MAXIMO / Math.max(bitmap.width, bitmap.height))
    const ancho = Math.max(1, Math.round(bitmap.width * escala))
    const alto = Math.max(1, Math.round(bitmap.height * escala))
    const canvas = document.createElement("canvas")
    canvas.width = ancho
    canvas.height = alto
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0, ancho, alto)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", CALIDAD_JPEG))
    return blob ? await leerComoDataUrl(blob) : null
  } finally {
    bitmap.close()
  }
}

/** La foto lista para mandar: achicada si se puede, la original si no. */
export async function fotoParaEnviar(file: File): Promise<string> {
  try {
    const achicada = await achicar(file)
    if (achicada) return achicada
  } catch {
    // Se manda la original (ver arriba).
  }
  return leerComoDataUrl(file)
}
