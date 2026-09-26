import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { listDeviceIngredients } from "@/api/inventory";
import { createSupplyRequest, getSupplySuggestions, type SupplySuggestion, type SupplySuggestions } from "@/api/requests";
import { Cargando } from "@/components/Cargando";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { unidadEnPlural } from "@/features/inventory/areaCountLib";
import { errorMessage } from "@/lib/errors";
import { formatCantidad } from "@/lib/format";

import { REQUESTS_QUERY_KEYS } from "./lib";

interface Linea {
  ingredientId: number;
  name: string;
  /** `entry_unit` del insumo: viaja con la cantidad y el servidor convierte. */
  entryUnit: string;
  qty: string;
  /** Vino de «Sugeridos»: bajo mínimo o en negativo en el área. */
  suggested: boolean;
  negative: boolean;
}

/** Cuántos insumos se ofrecen como resultado del buscador. */
const MAX_RESULTADOS = 8;

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Pedido de insumos desde el POS. **Arranca vacío**: arriba el buscador y los
 * «frecuentes» de la sede como botones de un toque; debajo, plegado,
 * «Sugeridos (N)» —lo que está bajo mínimo en el ÁREA de quien pide (la de
 * Conteo por área, o la de su puesto), con «Agregar todos»—. Antes arrancaba
 * con los 49 insumos bajo mínimo de toda la sede en gramos con decimales, y
 * pedir dos cosas costaba 58 toques.
 *
 * Las cantidades se escriben en la unidad cómoda del insumo (kg, L, botellas,
 * unidades) y viajan como texto con su `entry_unit`: el servidor convierte a
 * la unidad base una sola vez. La cantidad sugerida ya viene redondeada por
 * el servidor («0,5 kg», «2 botellas»). Nada de acá trae costos.
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

function SupplyRequestEditor({ suggestions }: { suggestions: SupplySuggestions | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const ingredients = useQuery({ queryKey: ["device", "ingredients"], queryFn: listDeviceIngredients });

  const [lineas, setLineas] = useState<Linea[]>([]);
  const [busqueda, setBusqueda] = useState("");
  const [verSugeridos, setVerSugeridos] = useState(false);
  const [nota, setNota] = useState("");
  const [error, setError] = useState<string | null>(null);

  const sugeridos = suggestions?.rows ?? [];
  const frecuentes = suggestions?.frequent ?? [];
  const enPedido = useMemo(() => new Set(lineas.map((l) => l.ingredientId)), [lineas]);
  const sugeridosPendientes = sugeridos.filter((s) => !enPedido.has(s.ingredient_id));

  const resultados = useMemo(() => {
    const texto = normalizar(busqueda);
    if (texto === "") return [];
    return (ingredients.data ?? [])
      .filter((i) => !enPedido.has(i.id) && normalizar(i.name).includes(texto))
      .slice(0, MAX_RESULTADOS);
  }, [busqueda, ingredients.data, enPedido]);

  const mutation = useMutation({
    mutationFn: () =>
      createSupplyRequest({
        lines: lineas.map((l) => ({ ingredient_id: l.ingredientId, qty: l.qty.trim(), entry_unit: l.entryUnit })),
        note: nota.trim() === "" ? null : nota.trim(),
      }),
    onSuccess: () => {
      toast.success("Pedido enviado al administrador.");
      setLineas([]);
      setNota("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.mine });
      void queryClient.invalidateQueries({ queryKey: REQUESTS_QUERY_KEYS.suggestions });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function setQty(ingredientId: number, qty: string) {
    setError(null);
    setLineas((prev) => prev.map((l) => (l.ingredientId === ingredientId ? { ...l, qty } : l)));
  }

  function quitar(ingredientId: number) {
    setLineas((prev) => prev.filter((l) => l.ingredientId !== ingredientId));
  }

  function agregar(linea: Linea) {
    setError(null);
    setLineas((prev) => (prev.some((l) => l.ingredientId === linea.ingredientId) ? prev : [...prev, linea]));
  }

  function desdeSugerido(s: SupplySuggestion): Linea {
    return {
      ingredientId: s.ingredient_id,
      name: s.name,
      entryUnit: s.entry_unit,
      qty: s.suggested_entry_qty,
      suggested: true,
      negative: s.negative,
    };
  }

  function agregarTodos() {
    setError(null);
    setLineas((prev) => [...prev, ...sugeridosPendientes.map(desdeSugerido)]);
  }

  const vacias = lineas.filter((l) => l.qty.trim() === "").map((l) => l.name);
  const alcance = suggestions?.area_name ? `de ${suggestions.area_name}` : "de la sede";

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <Label htmlFor="buscar-insumo">Buscar insumo</Label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="buscar-insumo"
            className="h-12 pl-10 text-base"
            placeholder="Escribí el nombre"
            autoComplete="off"
            value={busqueda}
            onChange={(event) => setBusqueda(event.target.value)}
          />
        </div>
        {busqueda.trim() !== "" && resultados.length === 0 && !ingredients.isLoading ? (
          <p className="text-sm text-muted-foreground">Ningún insumo activo se llama así.</p>
        ) : null}
        {resultados.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Insumos que coinciden">
            {resultados.map((i) => (
              <li key={i.id}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-12 text-base"
                  onClick={() => {
                    agregar({ ingredientId: i.id, name: i.name, entryUnit: i.entry_unit, qty: "", suggested: false, negative: false });
                    setBusqueda("");
                  }}
                >
                  + {i.name} ({unidadEnPlural(i.entry_unit)})
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {frecuentes.length > 0 ? (
        <div className="space-y-2">
          <p id="frecuentes" className="text-sm font-medium">
            Frecuentes
          </p>
          <ul className="flex flex-wrap gap-2" aria-labelledby="frecuentes">
            {frecuentes.map((f) => {
              const ya = enPedido.has(f.ingredient_id);
              return (
                <li key={f.ingredient_id}>
                  <Button
                    type="button"
                    variant={ya ? "secondary" : "outline"}
                    className="h-11 rounded-full px-4"
                    aria-pressed={ya}
                    disabled={ya}
                    onClick={() =>
                      agregar({
                        ingredientId: f.ingredient_id,
                        name: f.name,
                        entryUnit: f.entry_unit,
                        qty: "",
                        suggested: false,
                        negative: false,
                      })
                    }
                  >
                    {f.name}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {suggestions && !suggestions.available ? (
        <p className="text-sm text-muted-foreground">{suggestions.reason}</p>
      ) : sugeridos.length > 0 ? (
        <section aria-labelledby="sugeridos" className="rounded-lg border">
          <div className="flex flex-wrap items-center gap-2 p-2">
            <Button
              type="button"
              variant="ghost"
              className="h-11 flex-1 justify-start gap-2 text-base font-semibold"
              aria-expanded={verSugeridos}
              aria-controls="sugeridos-lista"
              onClick={() => setVerSugeridos((v) => !v)}
            >
              {verSugeridos ? <ChevronUp aria-hidden="true" className="size-5" /> : <ChevronDown aria-hidden="true" className="size-5" />}
              <span id="sugeridos">
                Sugeridos ({sugeridos.length}) {alcance}
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11"
              disabled={sugeridosPendientes.length === 0}
              onClick={agregarTodos}
            >
              Agregar todos
            </Button>
          </div>
          {verSugeridos ? (
            <ul id="sugeridos-lista" className="divide-y border-t">
              {sugeridos.map((s) => (
                <li key={s.ingredient_id} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.name}</p>
                    <p className="text-sm text-muted-foreground">
                      Pedir {formatCantidad(s.suggested_entry_qty, unidadEnPlural(s.entry_unit))}
                      {s.negative ? " · en negativo" : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    disabled={enPedido.has(s.ingredient_id)}
                    onClick={() => agregar(desdeSugerido(s))}
                  >
                    {enPedido.has(s.ingredient_id) ? "En el pedido" : "Agregar"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {suggestions?.other_areas_count ? (
            <p className="border-t px-3 py-2 text-xs text-muted-foreground">
              Otras áreas tienen {suggestions.other_areas_count} insumo
              {suggestions.other_areas_count === 1 ? "" : "s"} bajo mínimo: los pide quien es de esa área.
            </p>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="pedido-titulo" className="space-y-2">
        <h4 id="pedido-titulo" className="text-sm font-medium">
          Tu pedido{lineas.length > 0 ? ` (${lineas.length})` : ""}
        </h4>
        {lineas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Todavía no hay insumos. Buscalos arriba, tocá un frecuente o agregá los sugeridos.
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
                    className="h-12 w-24 text-center text-lg tabular-nums"
                    value={l.qty}
                    onChange={(event) => setQty(l.ingredientId, event.target.value)}
                  />
                  <span className="w-20 text-sm text-muted-foreground">{unidadEnPlural(l.entryUnit)}</span>
                  <Button type="button" variant="ghost" className="h-11" onClick={() => quitar(l.ingredientId)}>
                    Quitar
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

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
        className="h-12 w-full text-base"
        disabled={mutation.isPending || lineas.length === 0 || vacias.length > 0}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Enviando…" : "Enviar pedido"}
      </Button>
    </div>
  );
}
