"""Graba el POS haciendo una venta real, de punta a punta.

No son maquetas: es la app corriendo contra la base con seis meses de
operación adentro, manejada como la manejaría un mesero — con las pausas de un
dedo, no de un script.

Tres cosas que costaron descubrir y quedan acá para no volver a pagarlas:

1. `page.fill()` sobre «número de sede» **filtra una tecla al teclado del
   PIN**, que escucha en `window` para no exigir foco. El dígito de más
   completaba el PIN antes de tiempo y el último clic caía sobre un teclado ya
   deshabilitado. Se pone el valor con el setter nativo, sin teclear.
2. En `/pos/identify` el teclado **nace deshabilitado**: hay que elegir quién
   opera antes. No es un defecto, es el modelo de atribución del producto.
3. `Table.number` es **texto**, no entero.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099"
SALIDA = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/capturas/pos")
PIN_SEDE = "123456"
QUIEN = "Édison Cardona"
PIN_PERSONA = "6002"
COMENSALES = "2"

#: Qué se pide. La bandeja abre el diálogo de «Término de la carne» — se deja
#: a propósito: muestra que el producto modela el plato, no sólo su precio.
PEDIDO = [
    ("Bandeja paisa", "A punto"),  # exige término de la carne
    ("Arroz con pollo", None),
    ("Limonada de coco", None),
    ("Postre de natas", None),
]

SALIDA.mkdir(parents=True, exist_ok=True)


def poner_valor(pagina, selector: str, valor: str) -> None:
    """Escribe en un input controlado por React SIN teclear (ver nota 1)."""
    pagina.eval_on_selector(
        selector,
        """(e, v) => {
            const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value').set;
            setter.call(e, v);
            e.dispatchEvent(new Event('input', { bubbles: true }));
        }""",
        valor,
    )


def teclear_pin(pagina, pin: str, pausa: int = 300) -> None:
    for d in pin:
        pagina.click(f'[aria-label="Dígito {d}"]')
        pagina.wait_for_timeout(pausa)


def main() -> None:
    with sync_playwright() as pw:
        navegador = pw.chromium.launch(
            executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
            args=["--no-sandbox"],
        )
        contexto = navegador.new_context(
            viewport={"width": 1440, "height": 960},
            record_video_dir=str(SALIDA),
            record_video_size={"width": 1440, "height": 960},
        )
        pagina = contexto.new_page()
        marcas: list[tuple[str, float]] = []
        import time

        t0 = time.time()

        def hito(nombre: str, espera: int = 500) -> None:
            pagina.wait_for_timeout(espera)
            pagina.screenshot(path=str(SALIDA / f"{nombre}.png"))
            marcas.append((nombre, round(time.time() - t0, 2)))
            print(f"  ✓ {nombre:<26} t={time.time() - t0:6.2f}s")

        # ── 1. activar el dispositivo ───────────────────────────────────────
        pagina.goto(f"{BASE}/pos/activate", wait_until="networkidle")
        pagina.wait_for_selector("text=Activar este dispositivo", timeout=20_000)
        hito("01-activar", 1100)
        poner_valor(pagina, "#store-id", "1")
        pagina.wait_for_timeout(700)
        teclear_pin(pagina, PIN_SEDE)

        # ── 2. quién opera ──────────────────────────────────────────────────
        pagina.wait_for_url("**/pos/identify", timeout=25_000)
        pagina.wait_for_selector('[role="radiogroup"]', timeout=20_000)
        hito("02-quien-opera", 1300)
        pagina.click(f'[role="radio"][aria-label^="{QUIEN}"]')
        hito("03-persona-elegida", 900)
        teclear_pin(pagina, PIN_PERSONA)

        pagina.wait_for_url(lambda u: "/pos" in u and "identify" not in u, timeout=25_000)
        pagina.wait_for_timeout(1500)

        # ── 3. el salón, con mesas ocupadas de verdad ───────────────────────
        pagina.goto(f"{BASE}/pos/mesas", wait_until="networkidle")
        hito("04-salon", 2000)

        # ── 3b. suena el teléfono: apartar una mesa ─────────────────────────
        # Va ANTES de abrir mesa a propósito: es el orden real de una tarde.
        # Se aparta para dentro de 45 minutos, que cae dentro de la ventana de
        # anticipación del servidor — con una hora lejana la mesa no se
        # pintaría punteada y el plano de después no mostraría nada.
        from datetime import datetime, timedelta, timezone

        pagina.goto(f"{BASE}/pos/reservas", wait_until="networkidle")
        hito("04b-reservas", 1600)
        bogota = datetime.now(timezone.utc) - timedelta(hours=5)
        pagina.click("#reserva-mesa")
        pagina.wait_for_timeout(700)
        pagina.locator('[role="option"]').first.click()
        pagina.wait_for_timeout(500)
        poner_valor(pagina, "#reserva-hora", (bogota + timedelta(minutes=45)).strftime("%H:%M"))
        poner_valor(pagina, "#reserva-nombre", "Familia Rincón")
        poner_valor(pagina, "#reserva-telefono", "310 555 4412")
        pagina.wait_for_timeout(700)
        pagina.click('button:has-text("Apartar la mesa")')
        hito("04c-reserva-hecha", 2000)

        pagina.goto(f"{BASE}/pos/mesas", wait_until="networkidle")
        hito("04d-salon-reservada", 2000)

        # ── 4. abrir la mesa ────────────────────────────────────────────────
        # Elegir una mesa LIBRE, leyéndolo de la pantalla. Fijar «Mesa 3» a
        # mano se rompió apenas una corrida anterior la dejó ocupada: tocar
        # una mesa ocupada va directo a su comanda y nunca abre el diálogo de
        # comensales. El salón es estado, no decorado.
        # `:has-text("Libre")` excluye sola a la apartada: su tarjeta dice la
        # hora de la reserva, no «Libre». Es el mismo criterio de siempre —leer
        # el estado de la pantalla en vez de fijar un número de mesa— y acá
        # además evita abrir justo la mesa que se acaba de apartar.
        libre = pagina.locator('button:has-text("Libre")').first
        nombre_mesa = (libre.inner_text() or "").split("\n")[0].strip()
        print(f"  · mesa libre elegida: {nombre_mesa}")
        libre.click()
        # Esperar por el campo, no por el reloj: con un timeout fijo el
        # diálogo a veces todavía no estaba montado y el guion moría acá.
        pagina.wait_for_selector("#table-covers", timeout=15_000)
        hito("05-abrir-mesa", 900)
        poner_valor(pagina, "#table-covers", COMENSALES)
        pagina.wait_for_timeout(600)
        pagina.click('button:has-text("Abrir mesa")')
        pagina.wait_for_url("**/pos/comanda/**", timeout=25_000)
        hito("06-comanda-vacia", 2000)

        # ── 5. tomar el pedido ──────────────────────────────────────────────
        for plato, modificador in PEDIDO:
            # Los botones de producto se identifican por `aria-label`
            # («Agregar Bandeja paisa»), no por su texto interior, que incluye
            # el precio y cambia.
            pagina.click(f'button[aria-label="Agregar {plato}"]')
            pagina.wait_for_timeout(900)

            # Todo plato abre su diálogo: cantidad, curso, nota y —cuando lo
            # exige— el modificador obligatorio. Es la pantalla que muestra que
            # el producto modela el plato y no sólo su precio, así que se deja
            # ver antes de confirmar.
            confirmar = pagina.locator('button:has-text("Agregar a la comanda")')
            if confirmar.count() > 0:
                if modificador:
                    pagina.click(f'text="{modificador}"')
                    pagina.wait_for_timeout(700)
                    hito(f"07-modificador-{plato.split()[0].lower()}", 500)
                confirmar.first.click()
                # Esperar a que el diálogo se vaya: su velo intercepta los
                # clics siguientes y el guion moría en el plato de después.
                pagina.wait_for_selector(
                    'button:has-text("Agregar a la comanda")', state="detached", timeout=15_000
                )
                pagina.wait_for_timeout(600)
        hito("08-pedido-tomado", 1400)

        # ── 6. marchar a cocina ─────────────────────────────────────────────
        enviar = pagina.locator('button:has-text("Enviar")').first
        if enviar.count() > 0:
            enviar.click()
            hito("09-enviado-a-cocina", 2200)

        # ── 7. cobrar ───────────────────────────────────────────────────────
        pagina.click('button:has-text("Cuenta / Cobrar")')
        pagina.wait_for_url("**/pos/cobro/**", timeout=25_000)
        hito("10-cuenta", 2200)

        # ── 8. la propina: se PREGUNTA, no se cobra sola ────────────────────
        # Ley 1935 de 2018: voluntaria, ≤10 %, preguntada al presentar la
        # cuenta y separada de la venta y del impuesto. Que el botón diga el
        # monto exacto («Sí, $ 7.593») es la ley hecha pantalla.
        si_propina = pagina.locator('button:has-text("Sí, $")').first
        if si_propina.count() > 0:
            si_propina.click()
            hito("11-propina", 1600)

        def reportar(titulo: str) -> None:
            controles = pagina.eval_on_selector_all(
                "button,[role=button],input,[role=radio],[role=tab]",
                """els => els.slice(0, 200).map(e => ({
                    t: (e.innerText || e.getAttribute('aria-label') || e.getAttribute('placeholder') || '')
                         .replace(/\\s+/g,' ').trim().slice(0,44), id: e.id || ''
                })).filter(x => x.t || x.id)""",
            )
            print(f"\n  {titulo}:")
            interesa = ("cobrar", "pin", "dígito", "cambio", "vuelto", "confirm", "total", "documento", "imprimir")
            for c in controles:
                if any(k in c["t"].lower() for k in interesa) or "pin" in c["id"].lower():
                    print(f"    {c}")

        # El cajero toca los billetes que le dieron: dos de cincuenta.
        for atajo in ("+$ 50.000", "+$ 50.000"):
            b = pagina.locator(f'button:has-text("{atajo}")').first
            if b.count() > 0:
                b.click()
                pagina.wait_for_timeout(500)
        hito("12-efectivo-recibido", 1200)

        # ── 9. el PIN ES la confirmación del cobro ──────────────────────────
        # No hay botón «cobrar» aparte: «Ingresá tu PIN para cobrar». La plata
        # no se mueve sin que alguien ponga su nombre, que es la misma regla
        # que gobierna el resto del sistema.
        teclear_pin(pagina, PIN_PERSONA, 340)
        pagina.wait_for_url("**/pos/documento/**", timeout=30_000)
        hito("13-documento", 2600)

        # ── 10. de vuelta al salón: la mesa quedó libre ──────────────────────
        pagina.goto(f"{BASE}/pos/mesas", wait_until="networkidle")
        hito("14-salon-despues", 2000)

        contexto.close()
        navegador.close()

    # Las marcas se ESCRIBEN, no sólo se imprimen. Cortar los planos mirando
    # la consola fue lo que una vez dejó un rótulo hablando del plano
    # siguiente: `cortar_planos.py` las lee de acá y los cortes salen del
    # mismo número que produjo la grabación.
    marcas_json = SALIDA / "marcas.json"
    marcas_json.write_text(
        json.dumps([{"nombre": n, "t": t} for n, t in marcas], ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print("\n  marcas de tiempo (para cortar el video):")
    for nombre, t in marcas:
        print(f"    {t:6.2f}s  {nombre}")
    videos = sorted(SALIDA.glob("*.webm"))
    print(f"\n  marcas: {marcas_json}")
    print(f"  video: {videos[0] if videos else 'NO SE GRABÓ'}")


if __name__ == "__main__":
    main()
