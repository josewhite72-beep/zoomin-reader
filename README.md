# zoomin-reader

PWA de JoséWhite's PanaMentorLabs para leer cómics **.cbr / .cbz** en el teléfono, con zoom al tocar, lupa y lectura en voz alta.

## Gestos
- **Tocar** un punto → zoom (2.5× por defecto) centrado en ese punto
- **Tocar otra vez** → vuelve a la página completa (configurable: "ir a ese punto")
- **Mantener el dedo** → lupa que sigue el dedo
- **Pellizcar** → zoom libre · **Arrastrar** con zoom → moverse
- **Deslizar** a los lados → cambiar página (se invierte en modo manga)

## Lectura en voz alta (🔊)
Lee los textos que se ven en pantalla (lo ideal: hacer zoom sobre las cajas o globos y tocar 🔊).
- **Sin internet:** OCR con Tesseract.js dentro del teléfono. Prepara la imagen (escalado Lanczos, umbral por color para
  letras blancas y negras, borra bordes de cajas), separa cajas que están lado a lado, las ordena y limpia el texto
  (une palabras cortadas con guion, pasa de MAYÚSCULAS a minúsculas normales).
- **Con internet:** IA con visión (Google Gemini o Groq) con tu propia clave. Lee mejor los globos con letra estilizada,
  respeta el orden de lectura y detecta quién habla (cada personaje con un tono de voz distinto).
- Modo **Automático**: IA si hay internet y clave; si no hay o falla, pasa solo al modo sin internet.
- El texto aparece en una hoja abajo: se puede corregir tocándolo y volver a leer desde cualquier bloque.
- Lo reconocido se guarda por zona de página: la segunda vez se lee al instante.
- Opción "Leer automáticamente al hacer zoom".

## Funciones
- Abre RAR (incluido RAR5) y ZIP; detecta el formato real aunque la extensión esté mal
- Biblioteca local (IndexedDB) con portada y la página donde quedaste
- Funciona sin conexión (service worker); todo se procesa en el teléfono

## Estructura
```
index.html  styles.css  app.js  manifest.json  sw.js
icons/      (192, 512, maskable)
voz.js      lectura en voz alta (OCR local + IA + speechSynthesis)
vendor/     unrar.bundle.js + unrar.wasm (node-unrar-js 2.0.2), jszip.min.js (3.10.2)
            tesseract/ (tesseract.js 5.1.1, núcleo LSTM, idiomas spa/eng best_int)
```

## Despliegue
Subir todo el contenido a un repo `zoomin-reader` en GitHub e importarlo en Vercel (sin build, sitio estático).
Al cambiar archivos, sube `CACHE` en `sw.js` (v1 → v2) para que los teléfonos tomen la versión nueva.

## Limitaciones
- No abre RAR con contraseña, RAR divididos en partes (.part1.rar…) ni .cb7
