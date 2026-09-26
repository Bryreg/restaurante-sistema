import { Camera, Loader2, X } from "lucide-react";
import { useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";
import { fotoParaEnviar } from "@/lib/foto";

export interface PhotoCaptureFieldProps {
  value: string | null;
  onChange: (dataUrl: string | null) => void;
  label?: string;
  /** El servidor la exige (config de sede): resalta el campo como requerido. */
  required?: boolean;
  disabled?: boolean;
  /**
   * Avisa mientras la foto se achica (puede tardar un par de segundos en
   * la tablet). Quien arma el formulario deshabilita el envío mientras
   * tanto: si no, «Registrar» sale sin la foto que ya se ve elegida.
   */
  onProcessingChange?: (processing: boolean) => void;
}

/**
 * Captura una foto con `<input type="file" accept="image/*" capture>` (cámara
 * en tablet, selector de archivo en PC), la achica (`@/lib/foto`) y la manda
 * como *data URL* — así lo pide la spec (§ POS, "foto opcional/exigida"); el
 * servidor la guarda en su tabla y el registro se queda con la dirección. La obligatoriedad la valida
 * **el backend**: este campo sólo se marca visualmente `required` cuando
 * quien lo usa ya sabe (por un `400 PHOTO_REQUIRED`) que hace falta.
 */
export function PhotoCaptureField({
  value,
  onChange,
  label = "Foto",
  required = false,
  disabled = false,
  onProcessingChange,
}: PhotoCaptureFieldProps): React.JSX.Element {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setProcessing(true);
    onProcessingChange?.(true);
    try {
      const dataUrl = await fotoParaEnviar(file);
      onChange(dataUrl);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setProcessing(false);
      onProcessingChange?.(false);
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
        disabled={disabled || processing}
        onChange={(event) => void handleFile(event.target.files?.[0])}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          className="h-11 gap-2"
          disabled={disabled || processing}
          onClick={() => inputRef.current?.click()}
        >
          <Camera className="size-4" aria-hidden="true" />
          {value ? "Reemplazar foto" : "Tomar o elegir foto"}
        </Button>
        {processing ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Procesando foto…
          </p>
        ) : value ? (
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
