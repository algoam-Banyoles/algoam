# Multi YouTube Viewer PWA

Multi YouTube Viewer is a progressive web app for watching up to four YouTube videos simultaneously. It can be installed thanks to its manifest and service worker.

## Opening the app

1. Serve this directory with a local web server, e.g. `python -m http.server`.
2. Open `index.html` from your browser (for example `http://localhost:8000/index.html`).
3. When the page loads, it will automatically register `service-worker.js` to provide offline caching.

## Usage

- Enter up to four YouTube URLs and press **Carregar vídeos** to load them.
- Use **▶️ Reproduir tots** to play all videos and **⏸️ Pausar tots** to pause them.
- Links using `youtube.com/live/...` are converted to regular watch URLs.

## Updating the channel list

Run `node scripts/fetch_channels.js` to download the current Federació Catalana de Billar streams. The script saves the resulting array of channels to `canals.json`.
