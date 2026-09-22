"""Graba el admin: la otra cara del sistema, con seis meses de operación.

La venta que acaba de hacer el POS aparece acá sin que nadie la copie. Eso es
lo que hay que mostrar: no dos productos, uno solo visto desde los dos lados.
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8099"
SALIDA = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/capturas/admin")
SALIDA.mkdir(parents=True, exist_ok=True)

#: Ruta, nombre, y por qué está en el video. El orden es el del recorrido.
#: Ruta, nombre del hito, por qué está, y —cuando hace falta— qué pestaña
#: abrir antes de la foto.
#:
#: **Dinero abre en «Historial», no en «Operacional».** El rótulo de ese
#: plano promete «esperado, contado, diferencia y su causa», y Operacional
#: muestra los turnos de HOY: el que está corriendo todavía no se contó, así
#: que la tabla sale con tres guiones y un «Todavía no cerró ningún turno
#: hoy». Los arqueos con su diferencia y su causa —que son el punto del
#: producto— están en Historial. Un rótulo que promete lo que el plano no
#: muestra es peor que no tener el plano.
PANTALLAS = [
    ("/admin/hoy", "01-hoy", "el día en curso, con la venta recién hecha"),
    ("/admin/ventas", "02-ventas", "seis meses de venta, no una pantalla vacía"),
    ("/admin/dinero", "03-dinero", "los arqueos y sus diferencias con causa", "Historial"),
    ("/admin/analitica", "04-analitica", "la mezcla de medios moviéndose en el tiempo"),
    ("/admin/inventario", "05-inventario", "insumos, conteos y varianza"),
    ("/admin/compras", "06-compras", "proveedores y cuentas por pagar"),
    # Igual que Dinero: el rótulo promete «lo que vence, lo que ya salió y
    # lo que falta», y la pestaña de Gastos muestra sólo lo que YA salió.
    # «Obligaciones» es la que tiene las tres cosas —pagadas, pendientes y
    # vencidas, con su botón de saldar—, que es de lo que habla el plano.
    ("/admin/gastos", "07-gastos", "obligaciones vencidas y pagadas", "Obligaciones"),
    ("/admin/personal", "08-personal", "el equipo y su actividad"),
    ("/admin/fiscal/documentos", "09-documentos", "la numeración consecutiva"),
    ("/admin/notifications", "10-atencion", "lo que el sistema quiere que mires"),
]


def main() -> None:
    with sync_playwright() as pw:
        navegador = pw.chromium.launch(
            executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
            args=["--no-sandbox"],
        )
        contexto = navegador.new_context(
            viewport={"width": 1680, "height": 1000},
            record_video_dir=str(SALIDA),
            record_video_size={"width": 1680, "height": 1000},
        )
        pagina = contexto.new_page()
        t0 = time.time()
        marcas: list[tuple[str, float, int]] = []

        def hito(nombre: str, espera: int = 1800) -> None:
            pagina.wait_for_timeout(espera)
            pagina.screenshot(path=str(SALIDA / f"{nombre}.png"))
            # Se guarda la ESPERA además del instante: la foto se tomó
            # después de esperar, así que la pantalla estuvo quieta en ese
            # estado durante `espera` ms ANTES de `t`. Sin ese dato, el
            # cortador no sabe dónde empieza el plano y tiene que adivinar.
            marcas.append((nombre, round(time.time() - t0, 2), espera))
            print(f"  ✓ {nombre:<20} t={time.time() - t0:6.2f}s")

        # ── entrar ──────────────────────────────────────────────────────────
        pagina.goto(f"{BASE}/login", wait_until="networkidle")
        pagina.wait_for_timeout(900)
        pagina.fill('input[type="email"]', "admin@demo.local")
        pagina.wait_for_timeout(350)
        pagina.fill('input[type="password"]', "cambiar")
        pagina.wait_for_timeout(500)
        pagina.click('button[type="submit"]')
        pagina.wait_for_url("**/admin/**", timeout=30_000)

        for pantalla in PANTALLAS:
            ruta, nombre, porque = pantalla[0], pantalla[1], pantalla[2]
            pestana = pantalla[3] if len(pantalla) > 3 else None
            try:
                pagina.goto(f"{BASE}{ruta}", wait_until="networkidle", timeout=45_000)
                if pestana:
                    # Por el rol, no por el texto suelto: en una pantalla con
                    # tabla, «Historial» también aparece en la barra lateral.
                    pagina.get_by_role("tab", name=pestana).click()
                    pagina.wait_for_timeout(1200)
                hito(nombre)
            except Exception as exc:  # noqa: BLE001
                print(f"  ✗ {nombre:<20} {type(exc).__name__}: {str(exc)[:70]}")
            del porque

        marcas_json = SALIDA / "marcas.json"
        marcas_json.write_text(
            json.dumps(
            [{"nombre": n, "t": t, "espera_ms": e} for n, t, e in marcas], ensure_ascii=False, indent=1
        ),
            encoding="utf-8",
        )
        print(f"\n  marcas: {marcas_json}")

        contexto.close()
        navegador.close()

    print("\n  marcas de tiempo:")
    for nombre, t, _espera in marcas:
        print(f"    {t:6.2f}s  {nombre}")
    videos = sorted(SALIDA.glob("*.webm"))
    print(f"\n  video: {videos[0] if videos else 'NO SE GRABÓ'}")


if __name__ == "__main__":
    main()
