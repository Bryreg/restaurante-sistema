"""Corta el video grabado en planos, usando las marcas que dejó la grabación.

**Por qué existe este archivo.** La primera vez los cortes se eligieron a ojo
mirando la consola, y un plano quedó 0,7 s corrido: el rótulo «El salón»
terminó encima de un cuadro que ya mostraba el diálogo de comensales. El
rótulo describía el plano equivocado y nadie lo nota hasta que alguien mira
el video con atención.

Acá el corte sale del MISMO número que produjo la grabación
(`marcas.json`, escrito por `grabar_pos.py`). Cada hito se tomó tras una
espera `espera` en el guion, así que el plano empieza en `t - espera/1000` —
el instante en que la pantalla terminó de cambiar— y dura hasta el hito
siguiente.
"""

import json
import subprocess
import sys
from pathlib import Path

#: Qué hito abre cada plano del recorrido, y con qué nombre sale. El orden es
#: el de la grabación; el fin de cada plano es el comienzo del siguiente.
PLANOS = [
    ("01-activar", "p1-entrar"),
    ("04-salon", "p2-salon"),
    ("04b-reservas", "p2b-reserva"),
    ("04d-salon-reservada", "p2c-salon-reservada"),
    ("05-abrir-mesa", "p3-abrir-mesa"),
    ("06-comanda-vacia", "p4-comanda"),
    ("08-pedido-tomado", "p5-pedido"),
    ("09-enviado-a-cocina", "p6-cocina"),
    ("10-cuenta", "p7-cuenta"),
    ("11-propina", "p8-propina"),
    ("12-efectivo-recibido", "p9-cobro"),
    ("13-documento", "p10-documento"),
]

#: Ningún plano más corto que esto: un plano de 1,2 s no se alcanza a leer.
MINIMO = 2.0
#: Ni más largo: después de unos segundos mirando una pantalla quieta, el
#: video se siente lento aunque la pantalla esté bien.
MAXIMO = 6.0


def main() -> None:
    origen = Path(sys.argv[1])  # el .webm que grabó Playwright
    marcas_json = Path(sys.argv[2])  # marcas.json de la misma corrida
    destino = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/clips")
    destino.mkdir(parents=True, exist_ok=True)

    marcas = {m["nombre"]: m["t"] for m in json.loads(marcas_json.read_text(encoding="utf-8"))}
    orden = [m["nombre"] for m in json.loads(marcas_json.read_text(encoding="utf-8"))]

    for hito, salida in PLANOS:
        if hito not in marcas:
            print(f"  · falta el hito {hito}: se salta {salida}")
            continue
        inicio = marcas[hito]
        # El siguiente hito de la GRABACIÓN, no el siguiente plano: entre dos
        # planos puede haber hitos intermedios (los diálogos de modificador),
        # y cortar hasta el siguiente plano se los tragaría adentro.
        siguientes = [marcas[n] for n in orden if marcas[n] > inicio]
        fin = min(siguientes) if siguientes else inicio + MAXIMO
        dur = max(MINIMO, min(MAXIMO, round(fin - inicio, 2)))

        subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-ss", str(inicio), "-t", str(dur),
             "-i", str(origen), "-an", "-c:v", "libx264", "-preset", "veryfast",
             "-crf", "20", "-pix_fmt", "yuv420p", str(destino / f"{salida}.mp4")],
            check=True,
        )
        print(f"  ✓ {salida:<22} {inicio:6.2f}s + {dur:4.2f}s")

    print(f"\n  planos en {destino}")


if __name__ == "__main__":
    main()
