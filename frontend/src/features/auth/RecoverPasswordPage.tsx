/**
 * «Olvidé mi contraseña» (auditoría e5). El sistema no manda correos: se
 * recupera con el correo y uno de los códigos de recuperación que se
 * guardaron al activar la verificación en dos pasos (o al generarlos en
 * Ajustes › Seguridad). Si no hay códigos, otro administrador puede cambiar
 * la contraseña desde Equipo.
 */
import { useState } from "react";
import { Link } from "react-router-dom";

import { recoverPassword } from "@/api/auth";
import { useDensity } from "@/app/density";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

export default function RecoverPasswordPage(): React.JSX.Element {
  useDensity("oficina");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await recoverPassword(email.trim(), code.trim(), password);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Recuperar la contraseña</CardTitle>
          <CardDescription>
            Con tu correo y uno de tus <b className="text-foreground">códigos de recuperación</b>. Si no los tenés,
            pedile a otro administrador que te cambie la contraseña desde Equipo.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {done ? (
            <div className="space-y-3">
              <p role="status" className="text-sm">
                Listo: la contraseña quedó cambiada y ese código ya no sirve.
              </p>
              <Link to="/login" className="text-sm text-primary underline">
                Volver a entrar
              </Link>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <Label htmlFor="recover-email">Correo</Label>
                <Input id="recover-email" type="email" autoComplete="username" className="h-11" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="recover-code">Código de recuperación</Label>
                <Input id="recover-code" className="h-11" placeholder="ABCDE-FGHJK" value={code} onChange={(e) => setCode(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="recover-password">Contraseña nueva</Label>
                <Input id="recover-password" type="password" autoComplete="new-password" className="h-11" value={password} onChange={(e) => setPassword(e.target.value)} />
                <p className="text-xs text-muted-foreground">Al menos 10 caracteres.</p>
              </div>
              {error ? (
                <p role="alert" className="text-sm font-medium text-destructive">
                  {error}
                </p>
              ) : null}
              <Button type="submit" className="h-11 w-full" disabled={busy || !email || !code || password.length < 10}>
                {busy ? "Cambiando…" : "Cambiar la contraseña"}
              </Button>
              <Link to="/login" className="block text-center text-sm text-muted-foreground">
                Volver
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
