import { Camera, X } from "lucide-react"
import { useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"

export interface PhotoCaptureFieldProps {
  value: string | null
  onChange: (dataUrl: string | null) => void
  label?: string
  /** Marca el campo como requerido visualmente; la obligatoriedad real la valida el backend. */
  required?: boolean
  disabled?: boolean
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer la foto"))
    reader.readAsDataURL(file)
  })
}

/**
 * Captura una foto con `<input type="file" accept="image/*" capture>`
 * (cámara en tablet, selector de archivo en PC) y la manda como *data URL*.
 * Componente compartido: `src/features/shifts/PhotoCaptureField.tsx` ya
 * tenía uno igual, local a ese dominio (territorio ajeno, no se toca) — este
 * es el que usa cualquier pantalla nueva que necesite foto (merma, en este
 * pedido) en vez de copiarlo (AGENTS.md § "reutilizá y ampliá lo
 * compartido"; hallazgo O-4 de 1b-2 fue justo esta duplicación con el filtro
 * de fechas y el botón de CSV). Ver gaps del entregable: idealmente
 * `shifts/PhotoCaptureField.tsx` se elimina a favor de este en un pedido
 * futuro, cuando alguien con territorio en `shifts/` pueda migrarlo.
 */
export function PhotoCaptureField({
  value,
  onChange,
  label = "Foto",
  required = false,
  disabled = false,
}: PhotoCaptureFieldProps): React.JSX.Element {
  const inputId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File | undefined) {
    if (!file) return
    try {
      const dataUrl = await fileToDataUrl(file)
      onChange(dataUrl)
      setError(null)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        disabled={disabled}
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-11 gap-2"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <Camera className="size-4" aria-hidden="true" />
          {value ? "Reemplazar foto" : "Tomar o elegir foto"}
        </Button>
        {value ? (
          <>
            <img src={value} alt="Foto capturada" className="h-11 w-11 rounded-md border object-cover" />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-11"
              disabled={disabled}
              aria-label="Quitar foto"
              onClick={() => onChange(null)}
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </>
        ) : required ? (
          <p className="text-sm text-destructive">Esta operación exige foto.</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}

export default PhotoCaptureField
