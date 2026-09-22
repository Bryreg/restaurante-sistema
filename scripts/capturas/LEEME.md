# Cómo se graba el video del recorrido

El video no es una maqueta: es la app corriendo con seis meses de operación
adentro, manejada por Playwright. Estos cuatro guiones lo reproducen.

```bash
# 1. Una base con historia y con el turno de hoy ABIERTO (el POS no vende sin
#    turno abierto, y un «Hoy» en ceros no sirve para mostrar nada).
cd backend
DATABASE_URL="sqlite:///./demo.db" PYTHONPATH=. python -m app.seed
DATABASE_URL="sqlite:///./demo.db" PYTHONPATH=. python -m app.demo_operacion --meses 6 --hoy-en-curso

# 2. Mesas ocupadas: el generador cobra todas sus comandas y deja el salón
#    vacío. Un salón vacío a las seis de la tarde no es un restaurante.
DATABASE_URL="sqlite:///./demo.db" PYTHONPATH=. python ../scripts/capturas/ocupar_mesas.py

# 3. La app, sirviendo el frontend construido (`npm run build` antes).
DATABASE_URL="sqlite:///./demo.db" PYTHONPATH=. uvicorn app.main:app --port 8099

# 4. Grabar las dos caras.
python ../scripts/capturas/grabar_pos.py   http://127.0.0.1:8099 /tmp/capturas/pos
python ../scripts/capturas/grabar_admin.py http://127.0.0.1:8099 /tmp/capturas/admin

# 5. Cortar los planos y armar la composición (ver los comentarios de
#    `armar_recorrido.py` para las marcas de tiempo).
python ../scripts/capturas/armar_recorrido.py
```

## Lo que cuesta descubrir y por eso está escrito

- **`page.fill()` filtra una tecla al teclado del PIN.** El teclado escucha en
  `window` para no exigir foco; el dígito de más completaba el PIN antes de
  tiempo y el último clic caía sobre un teclado ya deshabilitado. Se usa el
  setter nativo del input.
- **En `/pos/identify` el teclado nace deshabilitado**: hay que elegir quién
  opera antes de teclear. Es el modelo de atribución, no un defecto.
- **`Table.number` es texto**, no entero.
- **Nunca fijar una mesa por nombre**: si una corrida anterior la dejó
  ocupada, tocarla va directo a su comanda y jamás abre el diálogo de
  comensales. Se elige una que diga «Libre», leyéndolo de la pantalla.
- **Cortar los planos por ojo produce rótulos que hablan del plano
  equivocado.** Cada corte sale de la marca de tiempo del hito menos su
  espera; `armar_recorrido.py` lee la duración real con `ffprobe` y acumula
  los inicios solo.
