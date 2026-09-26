import { zodResolver } from "@hookform/resolvers/zod";
import { Store } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router-dom";
import { z } from "zod";

import { adminLogin } from "@/api/auth";
import { Button, buttonVariants } from "@/components/ui/button";
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
  const { me, refresh } = useSession();
  const enTablet = me?.kind === "device";
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
      <div className="w-full max-w-sm space-y-3">
        <Card>
          <CardHeader>
            {/* Patrón 2 · Cabecera de pantalla: el nombre y **la pregunta que
                contesta**. «Restaurante Sistema» dice de quién es el producto,
                no qué hay que hacer acá; quien abre esta URL por primera vez
                necesita lo segundo. */}
            <p className="text-xs tracking-wider text-muted-foreground uppercase">Restaurante Sistema</p>
            <CardTitle className="text-xl">Entrar</CardTitle>
            <CardDescription>
              Esta es la puerta del <b className="font-bold text-foreground">escritorio del administrador</b>, en
              PC. El salón —mesas, comanda, cocina— no se entra por acá: entra por el dispositivo, abajo.
            </CardDescription>
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
          </CardContent>
        </Card>

        {enTablet ? (
          <Card>
            <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4">
              <Store className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold">Estás en una tablet del salón</p>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Acá la sesión de administrador dura 15 minutos y, al salir, la tablet vuelve sola a «Quién
                  opera». No hace falta activarla de nuevo.
                </p>
              </div>
              <Link to="/pos/identify" className={buttonVariants({ variant: "outline", className: "w-full" })}>
                Volver al POS
              </Link>
            </CardContent>
          </Card>
        ) : null}

        {/* La pantalla de activación existía y estaba bien hecha, pero sólo
            llegaba quien ya sabía la URL: la raíz manda acá, y acá no había
            nada que mencionara el POS. El dueño que monta una tablet abre el
            navegador, ve un formulario que le pide correo y contraseña de
            administrador —que no es lo que tiene que hacer— y no concluye «me
            falta un dato»: concluye que el producto no sirve. Pasa una vez por
            aparato, pero es la PRIMERA vez.

            Por eso el rediseño lo saca de la letra chica del pie: es la segunda
            puerta de esta pantalla, en su propia tarjeta, con el mismo peso que
            el formulario y un botón de verdad. Azul y secundario —no compite
            con «Ingresar», pero tampoco se esconde (`docs/DISENO.md`)—.
            No regala nada: activar sigue exigiendo el PIN de sede. */}
        <Card hidden={enTablet}>
          <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4">
            <Store className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold">¿Es una tablet o un PC del salón?</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Se activa una vez por aparato, con el PIN de la sede. Después el mesero sólo teclea su PIN
                personal.
              </p>
            </div>
            {/* Un `<Link>` con el vestido de botón, y no `Button
                render={<Link/>}`: el censo de controles
                (`src/audit/censo.ts`) lee el código, y con el enlace metido
                dentro de un atributo el rótulo deja de verse desde afuera. El
                control que la red no ve es el control que la red no protege,
                y éste es justamente el que el inventario marca como el
                candidato número uno a desaparecer. */}
            <Link
              to="/pos/activate"
              className={buttonVariants({
                variant: "outline",
                className: "w-full border-primary/40 text-primary hover:text-primary",
              })}
            >
              Activá este dispositivo
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
