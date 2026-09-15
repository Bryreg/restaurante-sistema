import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  addCustomerConsent,
  customerRequestsCsvUrl,
  customersCsvUrl,
  eraseCustomer,
  listCustomerRequests,
  listCustomers,
  patchCustomer,
  type ConsentIn,
  type ConsentPurpose,
  type CustomerOut,
  type CustomerPatchIn,
  type DataRequestOut,
} from "@/api/customers";
import { EmptyState } from "@/components/EmptyState";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatInstant } from "@/lib/businessDate";
import { errorMessage } from "@/lib/errors";

import { LocalCsvExportButton } from "./components";

const REQUEST_KIND_LABEL: Record<string, string> = {
  access: "Consulta",
  rectify: "Rectificación",
  revoke: "Revocación",
  erase: "Supresión",
};

/**
 * anonimiza el maestro y deja intacto el documento fiscal — con estas
 * palabras exactas, en el diálogo de confirmación (mandato del Maestro).
 */
const ERASE_EXPLANATION =
  "Esto anonimiza el maestro y deja intacto el documento fiscal: los datos de este cliente en el sistema se reemplazan por un marcador genérico, pero cada comprobante ya emitido conserva su copia exacta del nombre y el documento — un documento fiscal expedido es inmutable y no se puede tocar. Esta acción no se puede deshacer.";

function EraseCustomerAction({ customer }: { customer: CustomerOut }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");

  const mutation = useMutation({
    mutationFn: () => eraseCustomer(customer.id, { reason: reason.trim() }),
    onSuccess: () => {
      setReason("");
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
  });

  if (customer.erased_at) {
    return <Badge variant="outline">Anonimizado el {formatInstant(customer.erased_at)}</Badge>;
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger render={<Button type="button" variant="destructive" size="sm" />}>
        Anonimizar (habeas data)
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Anonimizar a {customer.name ?? "este cliente"}</AlertDialogTitle>
          <AlertDialogDescription>{ERASE_EXPLANATION}</AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1">
          <Label htmlFor={`erase-reason-${customer.id}`}>Motivo de la solicitud</Label>
          <Textarea id={`erase-reason-${customer.id}`} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(mutation.error)}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={reason.trim() === "" || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? "Anonimizando…" : "Anonimizar"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ConsentForm({ customer }: { customer: CustomerOut }) {
  const [purpose, setPurpose] = useState<ConsentPurpose>("invoice");
  const [granted, setGranted] = useState(true);
  const [channel, setChannel] = useState("");
  const [textVersion, setTextVersion] = useState("");

  const mutation = useMutation({
    mutationFn: () => {
      const body: ConsentIn = { purpose, granted, channel: channel.trim(), text_version: textVersion.trim() };
      return addCustomerConsent(customer.id, body);
    },
    onSuccess: () => {
      setChannel("");
      setTextVersion("");
    },
  });

  const canSubmit = channel.trim() !== "" && textVersion.trim() !== "";

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">Registrar consentimiento</p>
      <p className="text-xs text-muted-foreground">
        Nunca edita uno anterior: cada registro (incluida una revocación) queda como evidencia nueva, con fecha y
        canal.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`consent-purpose-${customer.id}`}>Finalidad</Label>
          <Select value={purpose} onValueChange={(v) => setPurpose(v as ConsentPurpose)}>
            <SelectTrigger id={`consent-purpose-${customer.id}`} className="h-10 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="invoice">Facturación</SelectItem>
              <SelectItem value="marketing">Mercadeo</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id={`consent-granted-${customer.id}`}
            checked={granted}
            onCheckedChange={(checked) => setGranted(checked === true)}
          />
          <Label htmlFor={`consent-granted-${customer.id}`}>Autoriza</Label>
        </div>
        <div className="space-y-1">
          <Label htmlFor={`consent-channel-${customer.id}`}>Canal</Label>
          <Input
            id={`consent-channel-${customer.id}`}
            className="h-10 w-32"
            placeholder="pos, whatsapp…"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`consent-text-${customer.id}`}>Versión del texto</Label>
          <Input
            id={`consent-text-${customer.id}`}
            className="h-10 w-32"
            placeholder="v1"
            value={textVersion}
            onChange={(e) => setTextVersion(e.target.value)}
          />
        </div>
        <Button type="button" className="h-10" disabled={!canSubmit || mutation.isPending} onClick={() => mutation.mutate()}>
          {mutation.isPending ? "Guardando…" : "Registrar"}
        </Button>
      </div>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      ) : null}
      {mutation.isSuccess ? <p className="text-sm text-muted-foreground">Consentimiento registrado.</p> : null}
    </div>
  );
}

function RequestsLog({ customer }: { customer: CustomerOut }) {
  const query = useQuery({
    queryKey: ["customer-requests", customer.id],
    queryFn: () => listCustomerRequests(customer.id),
  });
  const rows: DataRequestOut[] = query.data ?? [];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">Bitácora de habeas data</p>
        <LocalCsvExportButton href={customerRequestsCsvUrl(customer.id)} label="CSV" />
      </div>
      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Sin solicitudes registradas.</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex justify-between gap-2">
              <span>
                {row.kind ? (REQUEST_KIND_LABEL[row.kind] ?? row.kind) : "—"}
                {row.note ? ` — ${row.note}` : ""}
              </span>
              <span className="text-xs text-muted-foreground">{formatInstant(row.requested_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CustomerDetailDialog({ customer, onOpenChange }: { customer: CustomerOut | null; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CustomerPatchIn>({});

  const patchMutation = useMutation({
    mutationFn: (payload: CustomerPatchIn) => patchCustomer((customer as CustomerOut).id, payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["customers"] });
    },
  });

  if (!customer) return null;

  const erased = customer.erased_at != null;
  const current = { name: form.name ?? customer.name ?? "", email: form.email ?? customer.email ?? "", address: form.address ?? customer.address ?? "", municipality_dane: form.municipality_dane ?? customer.municipality_dane ?? "", dv: form.dv ?? customer.dv ?? "" };

  return (
    <Dialog open={customer !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{customer.name ?? "Cliente"}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 text-sm">
          <p className="text-muted-foreground">
            {customer.doc_type ?? "Doc."} {customer.doc_number ?? "—"}
            {customer.dv ? `-${customer.dv}` : ""}
          </p>

          {erased ? (
            <p role="status" className="text-sm text-muted-foreground">
              Este cliente está anonimizado. Sus datos ya no se pueden corregir ni recibir consentimientos nuevos; los
              documentos fiscales que ya se emitieron a su nombre conservan su copia exacta, sin cambios.
            </p>
          ) : (
            <div className="space-y-2 rounded-md border p-3">
              <p className="font-medium">Corregir datos</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="customer-name">Nombre</Label>
                  <Input id="customer-name" className="h-10" value={current.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="customer-dv">DV</Label>
                  <Input id="customer-dv" className="h-10" value={current.dv} onChange={(e) => setForm((f) => ({ ...f, dv: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="customer-email">Correo</Label>
                  <Input id="customer-email" type="email" className="h-10" value={current.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="customer-municipality">Municipio (DANE)</Label>
                  <Input id="customer-municipality" className="h-10" value={current.municipality_dane} onChange={(e) => setForm((f) => ({ ...f, municipality_dane: e.target.value }))} />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="customer-address">Dirección</Label>
                  <Input id="customer-address" className="h-10" value={current.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} />
                </div>
              </div>
              {patchMutation.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {errorMessage(patchMutation.error)}
                </p>
              ) : null}
              <Button type="button" className="h-10" disabled={patchMutation.isPending} onClick={() => patchMutation.mutate(form)}>
                {patchMutation.isPending ? "Guardando…" : "Guardar"}
              </Button>
            </div>
          )}

          {!erased ? <ConsentForm customer={customer} /> : null}

          <RequestsLog customer={customer} />

          <div className="flex justify-end border-t pt-3">
            <EraseCustomerAction customer={customer} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Admin → Clientes (SPEC-NEGOCIO §8.4, Ley 1581 de 2012; `spec.md` "API
 * contract → Customers"): `GET /admin/customers?doc_number=`,
 * `PATCH /admin/customers/{id}`, `POST /admin/customers/{id}/consents`,
 * `GET /admin/customers/{id}/requests`, `POST /admin/customers/{id}/erase`.
 * Detrás de la flag `customers` (gate en el backend; acá gatea la entrada
 * de navegación — `customersFeature.adminNav`).
 */
export function CustomersPage(): React.JSX.Element {
  const [docNumber, setDocNumber] = useState("");
  const [appliedDocNumber, setAppliedDocNumber] = useState<string | undefined>(undefined);
  const [selected, setSelected] = useState<CustomerOut | null>(null);

  const query = useQuery({
    queryKey: ["customers", appliedDocNumber],
    queryFn: () => listCustomers({ docNumber: appliedDocNumber }),
  });

  const rows = query.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Clientes</h1>
          <p className="text-sm text-muted-foreground">
            El dispositivo sólo los crea al cobrar; acá se administran, se corrigen y se ejercen los derechos de
            habeas data.
          </p>
        </div>
        <LocalCsvExportButton href={customersCsvUrl({ docNumber: appliedDocNumber })} />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="customers-doc-number">Número de documento</Label>
          <Input
            id="customers-doc-number"
            className="h-10 w-56"
            value={docNumber}
            onChange={(e) => setDocNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setAppliedDocNumber(docNumber.trim() || undefined);
            }}
          />
        </div>
        <Button type="button" variant="outline" className="h-10" onClick={() => setAppliedDocNumber(docNumber.trim() || undefined)}>
          Buscar
        </Button>
        {appliedDocNumber ? (
          <Button
            type="button"
            variant="ghost"
            className="h-10"
            onClick={() => {
              setDocNumber("");
              setAppliedDocNumber(undefined);
            }}
          >
            Limpiar
          </Button>
        ) : null}
      </div>

      {query.isLoading ? (
        <p className="text-sm text-muted-foreground">Cargando clientes…</p>
      ) : query.isError ? (
        <EmptyState role="alert" title="No se pudieron cargar los clientes" description={errorMessage(query.error)} />
      ) : rows.length === 0 ? (
        <EmptyState title="Ningún cliente coincide con esta búsqueda" />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Documento</TableHead>
                <TableHead>Nombre</TableHead>
                <TableHead>Correo</TableHead>
                <TableHead>Municipio</TableHead>
                <TableHead>Estado</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((customer) => (
                <TableRow key={customer.id} className="cursor-pointer" onClick={() => setSelected(customer)}>
                  <TableCell>
                    {customer.doc_type ?? "—"} {customer.doc_number ?? "—"}
                  </TableCell>
                  <TableCell>{customer.name ?? "—"}</TableCell>
                  <TableCell>{customer.email ?? "—"}</TableCell>
                  <TableCell>{customer.municipality_dane ?? "—"}</TableCell>
                  <TableCell>
                    {customer.erased_at ? <Badge variant="outline">Anonimizado</Badge> : <Badge variant="secondary">Activo</Badge>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CustomerDetailDialog key={selected?.id ?? "none"} customer={selected} onOpenChange={(open) => !open && setSelected(null)} />
    </div>
  );
}

export default CustomersPage;
