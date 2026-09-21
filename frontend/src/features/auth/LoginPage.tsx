import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";

import { adminLogin } from "@/api/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";

import { useDensity } from "@/app/density";
import { useSession } from "@/app/session";

const schema = z.object({
  email: z.string().min(1, "Ingresá tu correo").email("Ese correo no es válido"),
  password: z.string().min(1, "Ingresá tu contraseña"),
});

type FormValues = z.infer<typeof schema>;

/** `POST /auth/admin/login` — la cookie httpOnly la pone el servidor. */
export default function LoginPage(): React.JSX.Element {
  // Fuera de `AdminLayout`: es la puerta del escritorio y tiene que abrir
  // con la misma escala que lo que hay detrás.
  useDensity("oficina");
  const { refresh } = useSession();
  const navigate = useNavigate();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    try {
      await adminLogin(values);
      await refresh();
      // A la raíz, no a una pantalla fija: el índice de `/admin` decide cuál es
      // la de entrada (hoy «Hoy», antes «Funciones»). Con la ruta escrita acá,
      // 1b-2 cambió el índice del router y el login siguió cayendo en Funciones.
      navigate("/admin", { replace: true });
    } catch (err) {
      setServerError(errorMessage(err));
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Restaurante Sistema</CardTitle>
          <CardDescription>Ingresá con tu correo y contraseña de administrador.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
            <div className="space-y-2">
              <Label htmlFor="email">Correo</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                className="h-11"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? "email-error" : undefined}
                {...register("email")}
              />
              {errors.email ? (
                <p id="email-error" role="alert" className="text-sm text-destructive">
                  {errors.email.message}
                </p>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Contraseña</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                className="h-11"
                aria-invalid={Boolean(errors.password)}
                aria-describedby={errors.password ? "password-error" : undefined}
                {...register("password")}
              />
              {errors.password ? (
                <p id="password-error" role="alert" className="text-sm text-destructive">
                  {errors.password.message}
                </p>
              ) : null}
            </div>
            {serverError ? (
              <p role="alert" className="text-sm font-medium text-destructive">
                {serverError}
              </p>
            ) : null}
            <Button type="submit" className="h-11 w-full" disabled={isSubmitting}>
              {isSubmitting ? "Ingresando…" : "Ingresar"}
            </Button>
          </form>
          {/* La pantalla de activación existía y estaba bien hecha, pero sólo
              llegaba quien ya sabía la URL: la raíz manda acá, y acá no había
              nada que mencionara el POS. El dueño que monta una tablet abre
              el navegador, ve un formulario que le pide correo y contraseña de
              administrador —que no es lo que tiene que hacer— y no concluye
              «me falta un dato»: concluye que el producto no sirve. Pasa una
              vez por aparato, pero es la PRIMERA vez.
              No regala nada: activar sigue exigiendo el PIN de sede. */}
          <p className="mt-6 border-t pt-4 text-center text-sm text-muted-foreground">
            ¿Es una tablet o un PC del salón?{" "}
            <Link to="/pos/activate" className="font-medium text-foreground underline underline-offset-4">
              Activá este dispositivo
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
