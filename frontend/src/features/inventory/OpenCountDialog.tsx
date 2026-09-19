import { useMutation } from "@tanstack/react-query"
import { useState } from "react"
import { useNavigate } from "react-router-dom"

import { postOpenCount, type CountScope } from "@/api/inventory"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { errorMessage } from "@/lib/errors"

const SCOPE_HINT: Record<CountScope, string> = {
  key_items: "Los insumos marcados como críticos (5 a 15, el 60–70 % de las compras) — unos diez minutos.",
  full:
    "Todos los insumos activos — semanal en un restaurante chico, mensual como mínimo. El food cost real sólo se calcula entre dos conteos completos consecutivos.",
}

/**
 * Abre un conteo nuevo (`POST /admin/counts`, SPEC-NEGOCIO §5.4): elegir
 * alcance (críticos o completo) y arrancar. Nada más — la captura a ciegas
 * pasa a `CountCapturePage.tsx` en cuanto se abre, nunca en este diálogo.
 */
export function OpenCountDialog({ storeId, onOpened }: { storeId: number; onOpened: (countId: number) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<CountScope>("key_items")
  const navigate = useNavigate()

  const mutation = useMutation({
    mutationFn: () => postOpenCount(storeId, scope),
    onSuccess: (count) => {
      setOpen(false)
      onOpened(count.id)
      navigate(`/admin/inventario/conteos/${count.id}`)
    },
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) mutation.reset()
      }}
    >
      <DialogTrigger render={<Button />}>Abrir conteo</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Abrir un conteo</DialogTitle>
          <DialogDescription>
            El conteo se abre a ciegas: quien cuenta no ve el stock del sistema, sólo el conteo anterior.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="count-scope">Alcance</Label>
          <Select value={scope} onValueChange={(v) => setScope(v as CountScope)}>
            <SelectTrigger id="count-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="key_items">Críticos</SelectItem>
              <SelectItem value="full">Completo</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{SCOPE_HINT[scope]}</p>
        </div>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Abriendo…" : "Abrir conteo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default OpenCountDialog
