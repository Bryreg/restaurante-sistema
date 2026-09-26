import { ShieldCheck } from "lucide-react";
import { Link } from "react-router-dom";

import { buttonVariants } from "@/components/ui/button";

import { useSession } from "./session";

/**
 * «Modo autorización» (`/pos/autorizar`): a dónde llega el administrador que
 * teclea su PIN en «Quién opera». Decisión del dueño: en la tablet el
 * administrador **sólo autoriza** — no opera el salón, no entra al roster ni
 * a la asistencia, no suma horas ni propina (el backend lo hace cumplir).
 *
 * Autorizar no necesita estar identificado: la pantalla de quien opera pide
 * el PIN del supervisor o del administrador cuando hace falta
 * (`AuthorizerDialog` y compañía). Para configurar o corregir, «Administrar»
 * abre el admin en esta tablet con una sesión corta que vuelve sola a
 * «Quién opera».
 */
export default function AutorizarPage(): React.JSX.Element {
  const { me } = useSession();
  const nombre = me?.employee?.name ?? "Administrador";

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-5 py-10 text-center">
      <ShieldCheck className="size-10 text-primary" aria-hidden="true" />
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">Modo autorización</h1>
        <p className="text-base text-muted-foreground">
          {nombre}, como administrador en la tablet no operás el salón ni sumás horas o propinas. Cuando
          alguien necesite tu autorización —anular, cortesía, descuento, retiro— te va a pedir el PIN en su
          propia pantalla.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Link to="/login" className={buttonVariants({ className: "h-14 px-6 text-base" })}>
          Administrar
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">
        Para que opere otra persona, tocá «Cambiar de persona» arriba.
      </p>
    </div>
  );
}
