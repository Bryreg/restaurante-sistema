/**
 * Ajustes › Mi cuenta (auditoría e5): verificación en dos pasos, códigos de
 * recuperación y cambio de contraseña del administrador que está adentro.
 * El QR se dibuja en el navegador con `qrcode-generator`; el secreto nunca
 * sale de esta pantalla ni se guarda en el navegador.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import qrcode from "qrcode-generator";
import { useState } from "react";

import {
  changePassword,
  disableTotp,
  enableTotp,
  getAccountSecurity,
  regenerateRecoveryCodes,
  setupTotp,
} from "@/api/auth";
import { Cargando } from "@/components/Cargando";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

function QrSvg({ text }: { text: string }): React.JSX.Element {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  return (
    <div
      className="size-44 rounded-md bg-white p-2"
      aria-label="Código QR para la app de autenticación"
      role="img"
      // Es el SVG que genera la librería a partir de un texto nuestro.
      dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) }}
    />
  );
}

function RecoveryCodesList({ codes }: { codes: string[] }): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-l-[3px] border-l-warning bg-muted p-3">
      <p className="text-sm font-semibold">Guardá estos códigos ahora: no se vuelven a mostrar.</p>
      <p className="text-xs text-muted-foreground">
        Cada uno sirve una vez, para entrar sin el teléfono o para poner una contraseña nueva si la olvidás.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm" data-testid="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

export function AccountSecuritySection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: ["account-security"], queryFn: getAccountSecurity });
  const [setup, setSetup] = useState<{ secret: string; otpauth_uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["account-security"] });
  const setupMut = useMutation({ mutationFn: setupTotp, onSuccess: (data) => setSetup(data) });
  const enableMut = useMutation({
    mutationFn: () => enableTotp(code.trim()),
    onSuccess: (data) => {
      setCodes(data.recovery_codes);
      setSetup(null);
      setCode("");
      refresh();
    },
  });
  const disableMut = useMutation({
    mutationFn: () => disableTotp(password),
    onSuccess: () => {
      setPassword("");
      refresh();
    },
  });
  const regenMut = useMutation({
    mutationFn: () => regenerateRecoveryCodes(password),
    onSuccess: (data) => {
      setCodes(data.recovery_codes);
      setPassword("");
      refresh();
    },
  });
  const passwordMut = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setPasswordDone(true);
    },
  });

  if (state.isLoading) return <Cargando texto="Cargando tu cuenta…" />;
  const enabled = state.data?.totp_enabled ?? false;
  const left = state.data?.recovery_codes_left ?? 0;
  const anyError = setupMut.error ?? enableMut.error ?? disableMut.error ?? regenMut.error;

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">Verificación en dos pasos</h3>
          {enabled ? <Badge variant="secondary">Activa</Badge> : <Badge variant="outline">Apagada</Badge>}
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">
          Además de la contraseña, al entrar se pide un código de 6 dígitos de una app de autenticación (Google
          Authenticator, Microsoft Authenticator, 1Password…). Si alguien consigue tu contraseña, igual no entra.
        </p>
        {codes ? <RecoveryCodesList codes={codes} /> : null}
        {!enabled && !setup ? (
          <Button type="button" onClick={() => setupMut.mutate()} disabled={setupMut.isPending}>
            Configurar
          </Button>
        ) : null}
        {setup ? (
          <div className="flex flex-wrap items-start gap-4">
            <QrSvg text={setup.otpauth_uri} />
            <div className="min-w-0 space-y-2">
              <p className="text-sm">1. Escaneá el QR con la app. Si no podés, escribí esta clave:</p>
              <p className="font-mono text-sm break-all">{setup.secret}</p>
              <Label htmlFor="totp-confirm">2. Escribí el código que muestra la app</Label>
              <Input
                id="totp-confirm"
                inputMode="numeric"
                className="h-11 w-40"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <Button type="button" onClick={() => enableMut.mutate()} disabled={code.trim().length < 6 || enableMut.isPending}>
                Activar
              </Button>
            </div>
          </div>
        ) : null}
        {enabled ? (
          <div className="space-y-2">
            <p className="text-sm">
              Te quedan <b>{left}</b> códigos de recuperación sin usar.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label htmlFor="security-password">Tu contraseña</Label>
                <Input
                  id="security-password"
                  type="password"
                  className="h-10 w-56"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="button" variant="outline" onClick={() => regenMut.mutate()} disabled={!password || regenMut.isPending}>
                Generar códigos nuevos
              </Button>
              <Button type="button" variant="outline" onClick={() => disableMut.mutate()} disabled={!password || disableMut.isPending}>
                Apagar la verificación
              </Button>
            </div>
          </div>
        ) : null}
        {anyError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(anyError)}
          </p>
        ) : null}
      </section>

      <section className="space-y-3">
        <h3 className="text-base font-semibold">Cambiar la contraseña</h3>
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="password-current">Contraseña actual</Label>
            <Input id="password-current" type="password" autoComplete="current-password" className="h-10 w-56" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password-new">Contraseña nueva (10 o más)</Label>
            <Input id="password-new" type="password" autoComplete="new-password" className="h-10 w-56" value={next} onChange={(e) => setNext(e.target.value)} />
          </div>
          <Button type="button" onClick={() => passwordMut.mutate()} disabled={!current || next.length < 10 || passwordMut.isPending}>
            Cambiar contraseña
          </Button>
        </div>
        {passwordDone ? (
          <p role="status" className="text-sm">
            Contraseña cambiada.
          </p>
        ) : null}
        {passwordMut.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(passwordMut.error)}
          </p>
        ) : null}
      </section>
    </div>
  );
}
