import jsQR from "jsqr"
import { Camera, ScanLine } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Leer una etiqueta: por la cámara de la tablet, con una pistola lectora
 * (escribe el código y un Enter, como un teclado) o tecleando los 8
 * caracteres que van debajo del QR. Las tres llegan al mismo `onCode`; el
 * servidor acepta el código en minúsculas, con guiones o con el `ET-` del QR.
 */
export function ScanBox({ onCode, busy }: { onCode: (code: string) => void; busy?: boolean }): React.JSX.Element {
  const [value, setValue] = useState("")
  const [camera, setCamera] = useState(false)
  const inputId = useId()

  function submit(raw: string) {
    const code = raw.trim()
    if (!code) return
    onCode(code)
    setValue("")
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <Label htmlFor={inputId} className="mb-1.5 flex items-center gap-1.5 text-sm font-bold">
        <ScanLine className="size-4" aria-hidden />
        Leer una etiqueta
      </Label>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          submit(value)
        }}
      >
        <Input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Escaneá o escribí el código (ej. K7Q2 M9XH)"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="h-12 flex-1 font-mono text-base uppercase"
        />
        <Button type="submit" variant="outline" className="h-12" disabled={busy || !value.trim()}>
          Buscar
        </Button>
        <Button type="button" className="h-12" onClick={() => setCamera(true)}>
          <Camera className="size-5" aria-hidden />
          Cámara
        </Button>
      </form>
      <CameraDialog
        open={camera}
        onOpenChange={setCamera}
        onCode={(code) => {
          setCamera(false)
          submit(code)
        }}
      />
    </div>
  )
}

interface DetectedBarcode {
  rawValue: string
}
interface BarcodeDetectorLike {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>
}
type BarcodeDetectorCtor = new (opts: { formats: string[] }) => BarcodeDetectorLike

function nativeDetector(): BarcodeDetectorLike | null {
  const ctor = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  if (!ctor) return null
  try {
    return new ctor({ formats: ["qr_code"] })
  } catch {
    return null
  }
}

/**
 * La cámara trasera, leyendo cuadro por cuadro. Usa el lector del navegador
 * (`BarcodeDetector`, Chrome en Android) y, donde no existe (Safari en iPad),
 * decodifica el cuadro en la página (`jsQR`).
 */
function CameraDialog({
  open,
  onOpenChange,
  onCode,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCode: (code: string) => void
}): React.JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let stream: MediaStream | null = null
    let frame = 0
    let stopped = false
    const canvas = document.createElement("canvas")
    const detector = nativeDetector()

    async function tick() {
      if (stopped) return
      const video = videoRef.current
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        try {
          let found: string | null = null
          if (detector) {
            const codes = await detector.detect(video)
            found = codes[0]?.rawValue ?? null
          } else {
            canvas.width = video.videoWidth
            canvas.height = video.videoHeight
            const ctx = canvas.getContext("2d", { willReadFrequently: true })
            if (ctx) {
              ctx.drawImage(video, 0, 0)
              const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
              found = jsQR(img.data, img.width, img.height)?.data ?? null
            }
          }
          if (found && !stopped) {
            stopped = true
            onCode(found)
            return
          }
        } catch {
          // Un cuadro que no se pudo leer: se intenta con el siguiente.
        }
      }
      frame = window.setTimeout(() => void tick(), detector ? 150 : 250)
    }

    async function start() {
      setError(null)
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Este navegador no deja usar la cámara. Escribí el código que va debajo del QR.")
        return
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false })
        if (stopped) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const video = videoRef.current
        if (video) {
          video.srcObject = stream
          await video.play().catch(() => undefined)
        }
        void tick()
      } catch {
        setError("No se pudo abrir la cámara. Dale permiso en el navegador o escribí el código.")
      }
    }

    void start()
    return () => {
      stopped = true
      window.clearTimeout(frame)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [open, onCode])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Apuntá la cámara al QR</DialogTitle>
          <DialogDescription>Se lee solo cuando el QR queda dentro del recuadro.</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            {error}
          </p>
        ) : (
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video ref={videoRef} className="aspect-square w-full object-cover" muted playsInline />
            <div aria-hidden className="pointer-events-none absolute inset-[18%] rounded-lg border-4 border-white/80" />
          </div>
        )}
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          Cerrar
        </Button>
      </DialogContent>
    </Dialog>
  )
}
