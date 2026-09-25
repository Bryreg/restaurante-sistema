import { useMutation } from "@tanstack/react-query"
import { useId, useRef, useState } from "react"
import { toast } from "sonner"

import { ApiError, newIdempotencyKey } from "@/api/client"
import type { Novelty } from "@/api/novelties"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { errorMessage } from "@/lib/errors"

/**
 * «Resolver» una novedad: pide la nota de cómo se resolvió (obligatoria) y
 * confirma. Lo usan el POS y el admin; cada uno pasa su propia escritura
 * (`resolve`). Una novedad resuelta no se reabre ni se borra.
 */
export function ResolveNovelty({
  novelty,
  resolve,
  onResolved,
}: {
  novelty: Novelty
  resolve: (note: string, idempotencyKey: string) => Promise<Novelty>
  onResolved: () => void
}): React.JSX.Element {
  const [abierto, setAbierto] = useState(false)
  const [nota, setNota] = useState("")
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef(newIdempotencyKey())
  const id = useId()

  const mutation = useMutation({
    mutationFn: () => resolve(nota.trim(), keyRef.current),
    onSuccess: () => {
      toast.success("Novedad resuelta.")
      keyRef.current = newIdempotencyKey()
      setAbierto(false)
      setNota("")
      setError(null)
      onResolved()
    },
    onError: (err) => {
      if (!(err instanceof ApiError) || err.status !== 409) keyRef.current = newIdempotencyKey()
      setError(errorMessage(err))
    },
  })

  if (!abierto) {
    return (
      <Button
        type="button"
        variant="outline"
        className="h-10"
        aria-label={`Resolver «${novelty.title}»`}
        onClick={() => setAbierto(true)}
      >
        Resolver
      </Button>
    )
  }
  return (
    <div className="w-full space-y-2">
      <div className="space-y-1">
        <Label htmlFor={id}>¿Cómo se resolvió?</Label>
        <Input id={id} className="h-10" value={nota} onChange={(event) => setNota(event.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="h-10"
          disabled={nota.trim() === "" || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Confirmar resuelta
        </Button>
        <Button type="button" variant="ghost" className="h-10" onClick={() => setAbierto(false)}>
          Cancelar
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
