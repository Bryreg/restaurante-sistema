import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";

import {
  createTable,
  createZone,
  listTables,
  listZones,
  updateTable,
  updateZone,
} from "@/api/stores";
import {
  DenseTable,
  DenseTableBar,
  DependencyEmptyState,
  type DenseColumn,
} from "@/components/admin";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/errors";

/** Zonas y mesas de la sede: `/admin/zones`, `/admin/tables`. */
export function ZonesTablesSection({ storeId }: { storeId: number | null }): React.JSX.Element {
  const queryClient = useQueryClient();
  const zonesQuery = useQuery({
    queryKey: ["admin-zones", storeId],
    queryFn: () => listZones(storeId as number),
    enabled: storeId !== null,
  });
  const tablesQuery = useQuery({
    queryKey: ["admin-tables", storeId],
    queryFn: () => listTables(storeId as number),
    enabled: storeId !== null,
  });

  const [newZoneName, setNewZoneName] = useState("");
  const [newTableZoneId, setNewTableZoneId] = useState<number | null>(null);
  const [newTableNumber, setNewTableNumber] = useState("");
  const [newTableSeats, setNewTableSeats] = useState("4");
  const [error, setError] = useState<string | null>(null);

  if (storeId === null) {
    return <EmptyState title="Elegí una sede" description="Creá una sede en la pestaña Sedes primero." />;
  }

  async function refetch() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin-zones", storeId] }),
      queryClient.invalidateQueries({ queryKey: ["admin-tables", storeId] }),
    ]);
  }

  async function handleCreateZone() {
    setError(null);
    try {
      await createZone(storeId as number, { name: newZoneName });
      setNewZoneName("");
      await refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleToggleZoneActive(zoneId: number, active: boolean) {
    setError(null);
    try {
      await updateZone(zoneId, { active });
      await refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleCreateTable() {
    if (!newTableZoneId) return;
    setError(null);
    try {
      await createTable({ zone_id: newTableZoneId, number: newTableNumber, seats: Number(newTableSeats) });
      setNewTableNumber("");
      await refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleSaveLandmarks(zoneId: number, texto: string) {
    setError(null);
    try {
      // Separadas por coma al escribirlas; el servidor las guarda como lista.
      const landmarks = texto
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p !== "");
      await updateZone(zoneId, { landmarks });
      await refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleToggleCounter(tableId: number, isCounter: boolean) {
    setError(null);
    try {
      await updateTable(tableId, { is_counter: isCounter });
      await refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function handleToggleTableActive(tableId: number, active: boolean) {
    setError(null);
    try {
      await updateTable(tableId, { active });
      await refetch();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const zones = zonesQuery.data ?? [];
  const tables = tablesQuery.data ?? [];
  const zoneNameById = new Map(zones.map((z) => [z.id, z.name]));

  const zonasActivas = zones.filter((z) => z.active).length;
  const mesasActivas = tables.filter((t) => t.active).length;
  const sillasActivas = tables.filter((t) => t.active).reduce((n, t) => n + t.seats, 0);

  const zoneColumns: readonly DenseColumn<(typeof zones)[number]>[] = [
    { key: "name", header: "Zona", kind: "name", cell: (zone) => zone.name },
    {
      key: "tables",
      header: "Mesas",
      kind: "number",
      cell: (zone) => String(tables.filter((t) => t.zone_id === zone.id).length),
    },
    {
      key: "landmarks",
      header: "Referencias del salón",
      // Lo que ayuda a ubicarse en el plano: «Entrada», «Ventanal / Calle
      // 63», «Paso a cocina». Se escriben separadas por coma y el servidor
      // las guarda como lista. Son del LOCAL, no de la pantalla: el ventanal
      // de Chapinero da a la Calle 63 y el de otra sede no.
      cell: (zone) => (
        <Input
          className="h-9 min-w-48 text-xs"
          defaultValue={(zone.landmarks ?? []).join(", ")}
          placeholder="Entrada, Ventanal / Calle 63"
          aria-label={`Referencias del salón de la zona ${zone.name}`}
          onBlur={(e) => void handleSaveLandmarks(zone.id, e.target.value)}
        />
      ),
    },
    {
      key: "active",
      header: "Activa",
      widthPx: 70,
      cell: (zone) => (
        <Switch
          checked={zone.active}
          aria-label={`${zone.active ? "Desactivar" : "Activar"} zona ${zone.name}`}
          onCheckedChange={(next) => void handleToggleZoneActive(zone.id, next)}
        />
      ),
    },
  ];

  const tableColumns: readonly DenseColumn<(typeof tables)[number]>[] = [
    { key: "number", header: "Mesa", kind: "id", cell: (table) => table.number },
    { key: "zone", header: "Zona", cell: (table) => zoneNameById.get(table.zone_id) ?? "—" },
    { key: "seats", header: "Sillas", kind: "number", cell: (table) => String(table.seats) },
    {
      key: "is_counter",
      header: "Barra",
      widthPx: 70,
      // Una barra sigue siendo una mesa para el sistema —se abre, se cobra y
      // se cierra igual—; lo único distinto es cómo la dibuja el plano.
      cell: (table) => (
        <Switch
          checked={table.is_counter ?? false}
          aria-label={`Marcar ${table.number} como ${table.is_counter ? "mesa" : "barra"}`}
          onCheckedChange={(next) => void handleToggleCounter(table.id, next)}
        />
      ),
    },
    {
      key: "active",
      header: "Activa",
      widthPx: 70,
      cell: (table) => (
        <Switch
          checked={table.active}
          aria-label={`${table.active ? "Desactivar" : "Activar"} mesa ${table.number}`}
          onCheckedChange={(next) => void handleToggleTableActive(table.id, next)}
        />
      ),
    },
  ];

  return (
    <div className="grid items-start gap-3 lg:grid-cols-2">
      <section className="space-y-2">
        {zonesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <DenseTable
            caption="Zonas del salón"
            columns={zoneColumns}
            rows={zones}
            rowKey={(zone) => String(zone.id)}
            rowStatus={(zone) => (zone.active ? "ok" : "none")}
            rowInactive={(zone) => !zone.active}
            bar={
              <DenseTableBar
                shown={zones.length}
                total={zones.length}
                noun="zonas"
                hidden={zones.length > zonasActivas ? `${zones.length - zonasActivas} inactivas` : undefined}
              />
            }
            note={
              <>
                Desactivar una zona <b className="font-bold text-foreground">no borra sus mesas</b>: dejan de
                ofrecerse en el salón y vuelven cuando la zona se reactiva.
              </>
            }
            empty={
              <EmptyState
                title="Todavía no hay zonas"
                description="Una zona es un sector del salón: terraza, salón principal, barra. Las mesas cuelgan de una zona."
              />
            }
          />
        )}
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="new-zone-name" className="text-xs">
              Nueva zona
            </Label>
            <Input
              id="new-zone-name"
              className="h-10 w-48"
              value={newZoneName}
              onChange={(e) => setNewZoneName(e.target.value)}
            />
          </div>
          <Button type="button" size="sm" className="gap-1" disabled={!newZoneName.trim()} onClick={() => void handleCreateZone()}>
            <Plus className="size-4" aria-hidden="true" />
            Crear
          </Button>
        </div>
      </section>

      <section className="space-y-2">
        {tablesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <DenseTable
            caption="Mesas del salón, por zona"
            columns={tableColumns}
            rows={tables}
            rowKey={(table) => String(table.id)}
            rowStatus={(table) => (table.active ? "ok" : "none")}
            rowInactive={(table) => !table.active}
            bar={
              <DenseTableBar
                shown={tables.length}
                total={tables.length}
                noun="mesas"
                hidden={`${mesasActivas} activas · ${sillasActivas} sillas para sentar`}
              />
            }
            legend={[
              {
                term: "Desactivada no es borrada",
                meaning:
                  "la mesa deja de aparecer en el mapa del salón, pero sus comandas viejas siguen en los reportes con su número.",
              },
              {
                term: "Las sillas",
                meaning: "son la capacidad, no los comensales: cuántos comieron lo cuenta el mesero en la comanda.",
              },
            ]}
            empty={
              zones.length === 0 ? (
                <DependencyEmptyState
                  title="Todavía no hay mesas"
                  description="Una mesa vive en una zona. Primero tiene que existir la zona."
                  create={{ label: "Crear una zona", to: "/admin/settings" }}
                />
              ) : (
                <EmptyState
                  title="Todavía no hay mesas"
                  description="Sin mesas, el salón vende por mostrador: el mapa de mesas queda vacío."
                />
              )
            }
          />
        )}
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="new-table-zone" className="text-xs">
              Zona
            </Label>
            <Select
              value={newTableZoneId ? String(newTableZoneId) : undefined}
              onValueChange={(v) => setNewTableZoneId(Number(v))}
            >
              <SelectTrigger id="new-table-zone" className="h-10 w-36">
                <SelectValue placeholder="Elegir…" />
              </SelectTrigger>
              <SelectContent>
                {zones.map((zone) => (
                  <SelectItem key={zone.id} value={String(zone.id)}>
                    {zone.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-table-number" className="text-xs">
              Número
            </Label>
            <Input
              id="new-table-number"
              className="h-10 w-24"
              value={newTableNumber}
              onChange={(e) => setNewTableNumber(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-table-seats" className="text-xs">
              Sillas
            </Label>
            <Input
              id="new-table-seats"
              type="number"
              min={1}
              className="h-10 w-20"
              value={newTableSeats}
              onChange={(e) => setNewTableSeats(e.target.value)}
            />
          </div>
          <Button
            type="button"
            size="sm"
            className="gap-1"
            disabled={!newTableZoneId || !newTableNumber.trim()}
            onClick={() => void handleCreateTable()}
          >
            <Plus className="size-4" aria-hidden="true" />
            Crear
          </Button>
        </div>
      </section>

      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive lg:col-span-2">
          {error}
        </p>
      ) : null}
    </div>
  );
}
