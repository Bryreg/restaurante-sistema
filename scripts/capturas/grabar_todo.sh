#!/usr/bin/env bash
# Regenera la base, levanta la app y graba el recorrido entero, de una.
#
# **El orden importa y por eso está acá y no en la cabeza de nadie**: los
# «hace 18 min» de las mesas se escriben contra el reloj del momento en que
# se genera la base, así que grabar media hora después muestra un salón donde
# todo lleva media hora de más. Regenerar y grabar tienen que ir pegados.
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE_DB="${BASE_DB:-/tmp/video.db}"
PUERTO="${PUERTO:-8099}"
SALIDA="${SALIDA:-/tmp/capturas}"

cd "$RAIZ/backend"
export PYTHONPATH=. JWT_SECRET=dev-secret-change-me ENV=dev
export DATABASE_URL="sqlite:///${BASE_DB}"

echo "══ 1/6 · frontend"
( cd "$RAIZ/frontend" && npm run build >/dev/null 2>&1 )

echo "══ 2/6 · base nueva en ${BASE_DB}"
rm -f "$BASE_DB" "$BASE_DB-wal" "$BASE_DB-shm"
python3 -m app.seed >/dev/null
python3 ../scripts/capturas/encender_funciones.py | tail -2
python3 -m app.demo_operacion --meses "${MESES:-1.5}" --hoy-en-curso | tail -2
python3 ../scripts/capturas/ocupar_mesas.py | tail -20

echo "══ 3/6 · la app"
pkill -f "uvicorn app.main:app --port ${PUERTO}" 2>/dev/null || true
sleep 2
( setsid python3 -m uvicorn app.main:app --port "$PUERTO" > /tmp/api-recorrido.log 2>&1 & )
for _ in $(seq 1 30); do
  sleep 2
  [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PUERTO}/login")" = "200" ] && break
done
curl -s -o /dev/null -w "  app -> %{http_code}\n" "http://127.0.0.1:${PUERTO}/login"

echo "══ 4/6 · grabar el salón"
rm -rf "$SALIDA/pos" && python3 ../scripts/capturas/grabar_pos.py "http://127.0.0.1:${PUERTO}" "$SALIDA/pos" | tail -25

echo "══ 5/6 · grabar la administración"
rm -rf "$SALIDA/admin" && python3 ../scripts/capturas/grabar_admin.py "http://127.0.0.1:${PUERTO}" "$SALIDA/admin" | tail -20

echo "══ 6/6 · cortar los planos"
rm -rf /tmp/clips && mkdir -p /tmp/clips
python3 ../scripts/capturas/cortar_planos.py "$SALIDA"/pos/*.webm   "$SALIDA/pos/marcas.json"   /tmp/clips | tail -20
python3 ../scripts/capturas/cortar_planos.py "$SALIDA"/admin/*.webm "$SALIDA/admin/marcas.json" /tmp/clips | tail -20
python3 ../scripts/capturas/armar_recorrido.py | tail -25

echo
echo "listo. Falta renderizar:  npx hyperframes render  (en brag-output-recorrido/composition)"
