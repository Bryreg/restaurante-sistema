import { describe, expect, it } from "vitest"

import { fotoParaEnviar } from "@/lib/foto"

describe("fotoParaEnviar", () => {
  it("si el navegador no puede achicarla, manda la original: nunca pierde la foto", async () => {
    // jsdom no trae `createImageBitmap` ni `canvas`: es justo el caso de un
    // navegador que no puede achicar.
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], "recibo.jpg", { type: "image/jpeg" })
    const dataUrl = await fotoParaEnviar(file)
    expect(dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true)
  })
})
