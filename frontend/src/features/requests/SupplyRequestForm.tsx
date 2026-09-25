import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { listDeviceIngredients } from "@/api/inventory";
import { createSupplyRequest, getSupplySuggestions, type SupplySuggestions } from "@/api/requests";
import { Cargando } from "@/components/Cargando";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";

import { REQUESTS_QUERY_KEYS } from "./lib";

interface Linea {
  ingredientId: number;
  name: string;
  baseUnit: string;
  qty: string;
  /** Viene de la sugerencia: bajo mínimo o en negativo. */
  suggested: boolean;
  negative: boolean;
}

/**
 * Pedido de insumos desde el POS. **De entrada** trae los insumos bajo mínimo
 * o en negativo con la cantidad que falta para volver al mínimo (la calcula
 * el servidor, `suggested_qty`); se pueden quitar, cambiar o sumar otros del
 * catálogo del dispositivo, que no trae costos. La cantidad va en la unidad
 * base del insumo y viaja como texto: el servidor la valida.
 */
export function SupplyRequestForm(): React.JSX.Element {
  const suggestions = useQuery({ queryKey: REQUESTS_QUERY_KEYS.suggestions, queryFn: getSupplySuggestions });

  if (suggestions.isLoading) return <Cargando texto="Buscando qué falta…" />;
  if (suggestions.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {errorMessage(suggestions.error)}
      </p>
    );
  }
  return <SupplyRequestEditor suggestions={suggestions.data ?? null} />;
}

/** Las sugerencias entran como renglones UNA vez, al montar: después manda quien pide. */
function SupplyRequestEditor({ suggestions }: { suggestions: SupplySuggestions | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const ingredients = useQuery({ queryKey: ["device", "ingredients"], queryFn: listDeviceIngredients });

  const [lineas, setLineas] = useState<Linea[]>(() =>
    (suggestions?.rows ?? []).map((s) => ({
      ingredientId: s.ingredient_id,
      name: s.name,
      baseUnit: s.base_unit,
      qty: s.suggested_qty,
      suggested: true,
      negative: s.negative,
    })),
  );
  const [busqueda, setBusqueda] = useState("");
  const [nota, setNota] = useState("");
  const [error, setError] = useState<string | null>(null);

  const enPedido = useMemo(() => new Set(lineas.map((l) => l.ingredientId)), [lineas]);
  const candidatos = useMemo(() => {
    const texto = busqueda.trim().toLowerCase();
    if (texto === "") return [];
    return (ingredients.data ?? [])
      .filter((i) => !enPedido.has(i.id) && i.name.toLowerCase().includes(texto))
      .slice(0, 8);
  }, [busqueda, ingredients.data, enPedido]);

  const mutation = useMutation({
    mutationFn: () =>
      createSupplyRequest({
        lines: lineas.map((l) => ({ ingredient_id: l.ingredientId, qty: l.qty.trim() })),
        note: nota.trim() === "" ? null : nota.trim(),
      }),
    onSuccess: () => {
      toast.success("Pedido enviado al administrador.");
      setLineas([]);
      setNota("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.mine });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function setQty(ingredientId: number, qty: string) {
    setLineas((prev) => prev.map((l) => (l.ingredientId === ingredientId ? { ...l, qty } : l)));
  }

  function quitar(ingredientId: number) {
    setLineas((prev) => prev.filter((l) => l.ingredientId !== ingredientId));
  }

  function agregar(id: number, name: string, baseUnit: string) {
    setLineas((prev) => [...prev, { ingredientId: id, name, baseUnit, qty: "", suggested: false, negative: false }]);
    setBusqueda("");
  }

  const vacias = lineas.filter((l) => l.qty.trim() === "").map((l) => l.name);

  return (
    <div className="space-y-5">
      {suggestions && !suggestions.available ? (
        <p className="text-sm text-muted-foreground">{suggestions.reason}</p>
      ) : null}

      {lineas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No hay insumos en el pedido. Buscá abajo lo que haga falta.
        </p>
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="Insumos del pedido">
          {lineas.map((l) => (
            <li key={l.ingredientId} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{l.name}</p>
                {l.suggested ? (
                  <Badge variant={l.negative ? "destructive" : "secondary"}>
                    {l.negative ? "En negativo" : "Bajo mínimo"}
                  </Badge>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor={`qty-${l.ingredientId}`} className="sr-only">
                  Cantidad de {l.name}
                </Label>
                <Input
                  id={`qty-${l.ingredientId}`}
                  inputMode="decimal"
                  className="h-11 w-28"
                  value={l.qty}
                  onChange={(event) => setQty(l.ingredientId, event.target.value)}
                />
                <span className="w-10 text-sm text-muted-foreground">{l.baseUnit}</span>
                <Button type="button" variant="ghost" className="h-11" onClick={() => quitar(l.ingredientId)}>
                  Quitar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="space-y-2">
        <Label htmlFor="buscar-insumo">Agregar otro insumo</Label>
        <Input
          id="buscar-insumo"
          className="h-11"
          placeholder="Escribí el nombre"
          value={busqueda}
          onChange={(event) => setBusqueda(event.target.value)}
        />
        {candidatos.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {candidatos.map((i) => (
              <Button
                key={i.id}
                type="button"
                variant="outline"
                className="h-11"
                onClick={() => agregar(i.id, i.name, i.base_unit)}
              >
                + {i.name} ({i.base_unit})
              </Button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor="nota-insumos">Nota (opcional)</Label>
        <Textarea id="nota-insumos" value={nota} onChange={(event) => setNota(event.target.value)} />
      </div>

      {vacias.length > 0 ? (
        <p className="text-sm text-muted-foreground">Falta la cantidad de: {vacias.join(", ")}</p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="button"
        className="h-11"
        disabled={mutation.isPending || lineas.length === 0 || vacias.length > 0}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Enviando…" : "Enviar pedido"}
      </Button>
    </div>
  );
}
