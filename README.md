# zoomin-reader

PWA de PanaMentorLabs para leer cómics **.cbr / .cbz** en el teléfono, con zoom al tocar y lupa.

## Gestos
- **Tocar** un punto → zoom (2.5× por defecto) centrado en ese punto
- **Tocar otra vez** → vuelve a la página completa (configurable: "ir a ese punto")
- **Mantener el dedo** → lupa que sigue el dedo
- **Pellizcar** → zoom libre · **Arrastrar** con zoom → moverse
- **Deslizar** a los lados → cambiar página (se invierte en modo manga)

## Funciones
- Abre RAR (incluido RAR5) y ZIP; detecta el formato real aunque la extensión esté mal
- Biblioteca local (IndexedDB) con portada y la página donde quedaste
- Funciona sin conexión (service worker); todo se procesa en el teléfono

## Estructura
```
index.html  styles.css  app.js  manifest.json  sw.js
icons/      (192, 512, maskable)
vendor/     unrar.bundle.js + unrar.wasm (node-unrar-js 2.0.2), jszip.min.js (3.10.2)
```

## Despliegue
Subir todo el contenido a un repo `zoomin-reader` en GitHub e importarlo en Vercel (sin build, sitio estático).
Al cambiar archivos, sube `CACHE` en `sw.js` (v1 → v2) para que los teléfonos tomen la versión nueva.

## Limitaciones
- No abre RAR con contraseña, RAR divididos en partes (.part1.rar…) ni .cb7
