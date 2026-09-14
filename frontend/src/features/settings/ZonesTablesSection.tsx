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
import {
  Table as UiTable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Zonas</h2>
        {zonesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : zones.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay zonas.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <UiTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Nombre</TableHead>
                  <TableHead>Activa</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {zones.map((zone) => (
                  <TableRow key={zone.id}>
                    <TableCell>{zone.name}</TableCell>
                    <TableCell>
                      <Switch
                        checked={zone.active}
                        aria-label={`${zone.active ? "Desactivar" : "Activar"} zona ${zone.name}`}
                        onCheckedChange={(next) => void handleToggleZoneActive(zone.id, next)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </UiTable>
          </div>
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

      <section className="space-y-3">
        <h2 className="text-sm font-medium">Mesas</h2>
        {tablesQuery.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : tables.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay mesas.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border">
            <UiTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Número</TableHead>
                  <TableHead>Zona</TableHead>
                  <TableHead>Sillas</TableHead>
                  <TableHead>Activa</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tables.map((table) => (
                  <TableRow key={table.id}>
                    <TableCell>{table.number}</TableCell>
                    <TableCell>{zoneNameById.get(table.zone_id) ?? "—"}</TableCell>
                    <TableCell>{table.seats}</TableCell>
                    <TableCell>
                      <Switch
                        checked={table.active}
                        aria-label={`${table.active ? "Desactivar" : "Activar"} mesa ${table.number}`}
                        onCheckedChange={(next) => void handleToggleTableActive(table.id, next)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </UiTable>
          </div>
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
