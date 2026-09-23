# Plan de trabajo — emisión directa ante la DIAN (software propio)

Estado: **propuesta** (2026-09-23). Reemplaza, si el dueño la aprueba, la
frase de `SPEC-NEGOCIO.md §8.3` que da por hecho un proveedor tecnológico.
El modelo del documento fiscal (rangos, consecutivo, estados, contingencia,
evidencia, notas) **no cambia**: ya está construido y es el mismo para las
dos modalidades. Lo que cambia es quién firma, arma el XML y lo transmite.

## 1. Qué dice la norma (verificado en fuente oficial)

- La Resolución Única DIAN **000227 de 2025** (art. 1.5.1.5.1.1, que antes
  era el art. 28 de la Res. 000165/2023) admite tres modalidades:
  1. desarrollo informático propio o adquirido;
  2. servicio gratuito de la DIAN;
  3. proveedor tecnológico.
- **La modalidad 1 sirve para la factura y para el documento equivalente
  electrónico POS.** La 2 **no** sirve para el POS: lo excluye el parágrafo 2.
- El tiquete POS sólo aplica hasta **5 UVT** por venta sin impuestos, y el
  cliente siempre puede pedir factura. Por eso hacen falta **las dos**
  habilitaciones: DE POS (con sus notas de ajuste) y factura electrónica (con
  sus notas crédito y débito). Cada una se habilita por separado.
- Anexos vigentes: factura **v1.9**, documento equivalente **v1.0**, caja de
  herramientas DEE **v1.3** (XSD y ejemplos).
- Fuentes:
  - <https://normograma.dian.gov.co/dian/compilacion/docs/resolucion_dian_0227_2025.htm>
  - <https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/>
  - <https://www.dian.gov.co/impuestos/factura-electronica/Documents/Anexo-Tecnico-Documento-Equivalente-Electronico-V1-0-final.pdf>

**Sin verificar en fuente oficial**, a confirmar en la fase 0:

- cuántos documentos pide el set de pruebas del POS con software propio (un
  proveedor habla de 30 documentos y 10 notas) y en qué plazo;
- si el CUDE del POS usa la clave técnica o el PIN del software;
- el costo del certificado digital.

## 2. Qué hace el dueño y qué hace el software

| Lo hace el dueño (trámite) | Lo hace el software |
|---|---|
| RUT con la responsabilidad de facturador y el correo de recepción | XML UBL 2.1 del DE POS, la factura y las notas |
| Comprar el certificado digital a una entidad acreditada ante ONAC (Certicámara, GSE, Andes…), renovable cada 1-2 años | Firma XAdES-EPES con ese certificado |
| Registrarse como «desarrollo propio» en el catálogo de habilitación y anotar el **Software ID** y el **PIN** | CUDE/CUFE (SHA-384) y QR |
| Pedir en MUISCA los rangos de numeración del POS, de la factura y de contingencia, y asociar los prefijos | Transmisión SOAP con WS-Security; consulta de estado y de rangos |
| Iniciar el set de pruebas (el sistema lo corre) y pasar a producción | Envío al cliente del XML (AttachedDocument) y del PDF |
| Guardar la llave del certificado donde el sistema la lea sin que viva en el repositorio | Contingencia, reintentos y conservación durante 5 años |

## 3. Arquitectura: sobre lo que ya existe

La costura ya está hecha y probada. `app/fiscal/provider.py` define
`FiscalProvider` (`emit`, `retry`, `health`), y `get_provider(db, store)` elige
cuál usar. Hoy devuelve `PendingTransmissionProvider`. El plan agrega una
tercera clase, **`DianDirectProvider`**, sin tocar `pay_order` ni el modelo.

Módulos nuevos, todos bajo `app/fiscal/dian/`:

| Módulo | Qué hace | Cómo se prueba |
|---|---|---|
| `ubl.py` | Arma el XML del DE POS, la factura y las notas desde el `FiscalDocument` y su snapshot | Contra los XSD de la caja de herramientas v1.3 |
| `cude.py` | Calcula CUDE y CUFE con SHA-384 sobre la cadena del anexo (valores truncados a 2 decimales) | Contra los ejemplos oficiales del anexo |
| `signer.py` | Firma XAdES-EPES con la política DIAN (`signxml` + `cryptography`) | Verificación de la firma, y en fase 2 con el validador de la DIAN |
| `soap.py` | Cliente de `WcfDianCustomerServices.svc` con WS-Security X.509: `SendBillSync`, `SendTestSetAsync`, `GetStatus`, `GetStatusZip`, `GetNumberingRange` | Respuestas grabadas de habilitación, sin red en CI |
| `qr.py` | URL de consulta `catalogo-vpfe(-hab).dian.gov.co/document/searchqr?documentkey=…` | Unitario |
| `attached.py` | AttachedDocument, que envuelve el documento y la respuesta de la DIAN, para el cliente | Contra XSD |
| `provider.py` | `DianDirectProvider`: orquesta los módulos y traduce la respuesta a `EmitResult` | Con el `FakeProvider` de siempre, más un doble del SOAP |

**Un cambio de fondo: la transmisión sale del cobro.** Hoy `emit_and_apply`
se llama dentro de la transacción del pago. Está bien mientras nadie
transmite, pero la DIAN puede tardar segundos, y el cajero no puede quedar
esperando. El cambio:

1. El cobro emite el documento en `pending`, numerado, con CUDE y QR.
   Esos dos se calculan localmente, así que el tiquete sale impreso completo.
2. Un **transmisor** fuera de la transacción envía, consulta el estado y
   aplica el resultado. Es un proceso aparte o un job periódico, y hay que
   decidir el mecanismo en Render.
3. Si la DIAN no responde, el documento pasa a contingencia tipo 08, con los
   reintentos que pide el anexo, y el transmisor reintenta. Esto ya lo
   modelan `contingency` y `sweep_contingency_overdue`.

**Configuración nueva por sede** (migración): modo (`pending`, `habilitacion`
o `produccion`), Software ID, PIN del software, `TestSetId` y una referencia
al certificado. **El certificado y su clave nunca van a la base ni al
repositorio**: se guardan en un secreto del host y la base sólo sabe cómo
se llama.

## 4. Fases

Las estimaciones son de una persona a tiempo completo y ya incluyen tests.

| Fase | Entregable | Estimación | Depende de |
|---|---|---|---|
| **0. Trámite y verificación** | Certificado comprado; registro en habilitación; Software ID, PIN y TestSetId; resueltos los tres «sin verificar» de §1 | 1-2 semanas de calendario, poco trabajo técnico | El dueño |
| **1. XML y CUDE** | `ubl.py` + `cude.py` para el DE POS y su nota de ajuste, validados contra XSD y ejemplos | 1,5 semanas | — |
| **2. Firma y SOAP** | `signer.py` + `soap.py`; un documento de prueba **aceptado** en el ambiente de habilitación | 1,5 semanas | Fase 0 (certificado) |
| **3. Transmisor y contingencia** | Emisión fuera del cobro, reintentos, contingencia 07/08, `health()` real, alerta de la pantalla «Requiere tu atención» | 1 semana | 2 |
| **4. Set de pruebas del POS** | El sistema corre el set completo en habilitación; la DIAN marca «habilitado» | 0,5 semana más la espera de la DIAN | 3 |
| **5. Factura electrónica** | Factura, nota crédito y nota débito (anexo 1.9); su set de pruebas | 1,5 semanas | 4 |
| **6. Entrega al cliente** | AttachedDocument y PDF por correo cuando hay adquirente con email | 0,5 semana | 5 |
| **7. Producción y conservación** | Cambio a producción por sede; `GetNumberingRange` para validar el rango cargado; exportación periódica del XML firmado | 0,5 semana | 6 |

**Total: 7 a 8 semanas de desarrollo, más el trámite.** Recomendación: hacer
el POS primero (fases 1 a 4). Es lo que sale en casi todas las ventas de un
restaurante, y el sistema ya maneja el tope de 5 UVT que deriva a factura.

## 5. Riesgos y cómo se cubren

- **La DIAN cambia el anexo.** En tres años salieron las resoluciones 165,
  008, 119, 202 y 227. Mitigación: aislar todo en `app/fiscal/dian/`, fijar
  los XSD en el repo, y tener un test de regresión por versión de anexo.
- **El certificado vence y se deja de facturar.** Mitigación: `health()` lee
  el vencimiento, y un aviso sale en «Requiere tu atención» 30 días antes.
- **Rechazos.** Hoy ya se notifican (`fiscal_rejected`) y no liberan el
  consecutivo. Falta mostrar el motivo de la DIAN en palabras del dueño.
- **La contingencia mal hecha es sanción.** Hay que seguir el anexo DEE §15
  al pie de la letra, y hacer un test por cada camino (07 y 08).
- **Soporte.** Con software propio no hay a quién llamar: el equipo es el
  proveedor. Si eso no es aceptable, la costura permite enchufar un
  proveedor tecnológico con una clase y sin tocar el resto. **Las dos
  opciones no se excluyen**: se puede arrancar con un proveedor y migrar
  después, o al revés.

## 6. Librerías

Revisadas; ninguna sirve tal cual para el POS:

- **Python:** `bit4bit/facho` (GPL-3.0) tiene XML, firma y CUFE, pero su
  último release en PyPI es de 2021 y no soporta el DE POS.
- **PHP:** `Stenfrank/ubl21dian` es de 2019, anterior al anexo 1.9.

Sirven como referencia para la firma y el WS-Security. El XML del POS se
escribe contra la caja de herramientas v1.3. Para la firma se usan
`signxml` y `cryptography`, que están mantenidas.

## 7. Qué decide el dueño antes de arrancar

1. Si va con software propio (este plan) o con un proveedor tecnológico.
2. Quién compra el certificado y a nombre de quién: el del NIT del
   restaurante.
3. Cómo se guarda el certificado en el host, y quién lo renueva.
4. Si el transmisor corre como proceso aparte en Render (costo mensual
   adicional) o como job del mismo servicio.
