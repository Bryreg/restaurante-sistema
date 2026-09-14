import { Camera, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

export interface PhotoCaptureFieldProps {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  label?: string;
  /** El servidor la exige (config de sede): resalta el campo como requerido. */
  required?: boolean;
  disabled?: boolean;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("No se pudo leer la foto"));
    reader.readAsDataURL(file);
  });
}

/**
 * Captura una foto con `<input type="file" accept="image/*" capture>` (cámara
 * en tablet, selector de archivo en PC) y la manda como *data URL* — así lo
 * pide la spec (§ POS, "foto opcional/exigida"). La obligatoriedad la valida
 * **el backend**: este campo sólo se marca visualmente `required` cuando
 * quien lo usa ya sabe (por un `400 PHOTO_REQUIRED`) que hace falta.
 */
export function PhotoCaptureField({
  value,
  onChange,
  label = "Foto",
  required = false,
  disabled = false,
}: PhotoCaptureFieldProps): React.JSX.Element {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    try {
      const dataUrl = await fileToDataUrl(file);
      onChange(dataUrl);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
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
            <img
              src={value}
              alt="Foto del conteo capturada"
              className="h-11 w-11 rounded-md border object-cover"
            />
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
          <p className="text-sm text-destructive">La sede exige foto para esta operación.</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
