import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { OpeningHour, StoreCreateIn, StoreOut, StoreUpdateIn } from "@/api/stores";

const WEEKDAYS = [
  { value: 0, label: "Lunes" },
  { value: 1, label: "Martes" },
  { value: 2, label: "Miércoles" },
  { value: 3, label: "Jueves" },
  { value: 4, label: "Viernes" },
  { value: 5, label: "Sábado" },
  { value: 6, label: "Domingo" },
];

/** Los cinco canales de VENTA que `create_order` gatea contra
 * `active_channels`. Tienen que estar TODOS: un canal que el servidor exige y
 * esta pantalla no ofrece deja al administrador con un error que le dice
 * «activalo en Configuración» y una Configuración donde no puede activarlo.
 *
 * Faltaban dos. `counter` se exigía desde 1b y nunca fue tildable —quedaba
 * congelado en lo que trajera el alta—; `platform` llegó con 2c. Y «Domicilio»
 * estaba de adorno: el administrador la tildaba y el servidor no la miraba.
 *
 * `staff_meal` NO va: no es un canal que la sede elija, es el consumo del
 * personal, y su único interruptor es la función `pos.staff_meal`. */
const CHANNELS = [
  { value: "counter", label: "Mostrador" },
  { value: "dine_in", label: "Mesas" },
  { value: "takeout", label: "Para llevar" },
  { value: "delivery", label: "Domicilio" },
  { value: "platform", label: "Plataformas" },
];

export interface StoreFormValues {
  name: string;
  nit: string;
  dv: string;
  legal_name: string;
  address: string;
  municipality_dane: string;
  cutoff_hour: number;
  active_channels: string[];
  opening_hours: OpeningHour[];
  store_pin: string;
}

function emptyValues(): StoreFormValues {
  return {
    name: "",
    nit: "",
    dv: "",
    legal_name: "",
    address: "",
    municipality_dane: "",
    cutoff_hour: 6,
    active_channels: [],
    opening_hours: [],
    store_pin: "",
  };
}

function fromStore(store: StoreOut): StoreFormValues {
  return {
    name: store.name,
    nit: store.nit ?? "",
    dv: store.dv ?? "",
    legal_name: store.legal_name ?? "",
    address: store.address ?? "",
    municipality_dane: store.municipality_dane ?? "",
    cutoff_hour: store.cutoff_hour,
    active_channels: store.active_channels,
    opening_hours: store.opening_hours,
    store_pin: "",
  };
}

export interface StoreFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `undefined` = crear sede nueva; con sede = editar (sin cambiar el PIN acá). */
  store?: StoreOut;
  onSubmit: (values: StoreCreateIn | StoreUpdateIn) => Promise<void>;
  error?: string | null;
}

export function StoreFormDialog({ open, onOpenChange, store, onSubmit, error }: StoreFormDialogProps) {
  const [values, setValues] = useState<StoreFormValues>(store ? fromStore(store) : emptyValues());
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(store ? fromStore(store) : emptyValues());
    }
  }, [open, store]);

  function toggleChannel(channel: string, checked: boolean) {
    setValues((prev) => ({
      ...prev,
      active_channels: checked
        ? [...prev.active_channels, channel]
        : prev.active_channels.filter((c) => c !== channel),
    }));
  }

  function dayHours(weekday: number): OpeningHour | undefined {
    return values.opening_hours.find((h) => h.weekday === weekday);
  }

  function toggleDay(weekday: number, open_: boolean) {
    setValues((prev) => ({
      ...prev,
      opening_hours: open_
        ? [...prev.opening_hours, { weekday, open: "08:00", close: "22:00" }]
        : prev.opening_hours.filter((h) => h.weekday !== weekday),
    }));
  }

  function setDayTime(weekday: number, field: "open" | "close", time: string) {
    setValues((prev) => ({
      ...prev,
      opening_hours: prev.opening_hours.map((h) => (h.weekday === weekday ? { ...h, [field]: time } : h)),
    }));
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      if (store) {
        const { store_pin: _pin, ...rest } = values;
        await onSubmit(rest);
      } else {
        await onSubmit(values);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{store ? `Editar ${store.name}` : "Nueva sede"}</DialogTitle>
          <DialogDescription>
            NIT, dígito de verificación y municipio (código DANE) son datos fiscales de la sede.
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="store-name">Nombre</Label>
              <Input
                id="store-name"
                required
                className="h-11"
                value={values.name}
                onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="store-nit">NIT</Label>
              <Input
                id="store-nit"
                className="h-11"
                value={values.nit}
                onChange={(e) => setValues((v) => ({ ...v, nit: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="store-dv">DV</Label>
              <Input
                id="store-dv"
                className="h-11"
                value={values.dv}
                onChange={(e) => setValues((v) => ({ ...v, dv: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="store-legal-name">Razón social</Label>
              <Input
                id="store-legal-name"
                className="h-11"
                value={values.legal_name}
                onChange={(e) => setValues((v) => ({ ...v, legal_name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="store-address">Dirección</Label>
              <Input
                id="store-address"
                className="h-11"
                value={values.address}
                onChange={(e) => setValues((v) => ({ ...v, address: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="store-municipality">Municipio (código DANE)</Label>
              <Input
                id="store-municipality"
                className="h-11"
                value={values.municipality_dane}
                onChange={(e) => setValues((v) => ({ ...v, municipality_dane: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="store-cutoff">Hora de corte</Label>
              <Input
                id="store-cutoff"
                type="number"
                min={0}
                max={23}
                className="h-11"
                value={values.cutoff_hour}
                onChange={(e) => setValues((v) => ({ ...v, cutoff_hour: Number(e.target.value) }))}
              />
            </div>
            {!store ? (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="store-pin">PIN de sede</Label>
                <Input
                  id="store-pin"
                  required
                  inputMode="numeric"
                  pattern="[0-9]{4,8}"
                  className="h-11"
                  value={values.store_pin}
                  onChange={(e) => setValues((v) => ({ ...v, store_pin: e.target.value }))}
                />
              </div>
            ) : null}
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Canales activos</legend>
            <div className="flex flex-wrap gap-4">
              {CHANNELS.map((channel) => (
                <label key={channel.value} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={values.active_channels.includes(channel.value)}
                    onCheckedChange={(checked) => toggleChannel(channel.value, checked === true)}
                  />
                  {channel.label}
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Horario por día</legend>
            <div className="space-y-1.5">
              {WEEKDAYS.map((day) => {
                const hours = dayHours(day.value);
                return (
                  <div key={day.value} className="flex flex-wrap items-center gap-2">
                    <label className="flex w-32 items-center gap-2 text-sm">
                      <Checkbox
                        checked={Boolean(hours)}
                        onCheckedChange={(checked) => toggleDay(day.value, checked === true)}
                      />
                      {day.label}
                    </label>
                    <Input
                      type="time"
                      disabled={!hours}
                      className="h-9 w-28"
                      aria-label={`Hora de apertura ${day.label}`}
                      value={hours?.open ?? ""}
                      onChange={(e) => setDayTime(day.value, "open", e.target.value)}
                    />
                    <span className="text-sm text-muted-foreground">a</span>
                    <Input
                      type="time"
                      disabled={!hours}
                      className="h-9 w-28"
                      aria-label={`Hora de cierre ${day.label}`}
                      value={hours?.close ?? ""}
                      onChange={(e) => setDayTime(day.value, "close", e.target.value)}
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>

          {error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
