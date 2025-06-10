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

## Installing dependencies

This project uses a small Node script to retrieve channel data. Run `npm install`
from the repository root to install the required packages before executing any
scripts.

## Running `scripts/fetch_channels.js`

The channel fetcher checks the configured channels for live streams. Execute it
with Node:

```bash
node scripts/fetch_channels.js
```

The script expects a **YouTube API key** available through the `YOUTUBE_API_KEY`
environment variable. The key is necessary for the live-check feature described
below.

## Live-check feature

The app can display which channels are currently live. Provide your YouTube API
key (as `YOUTUBE_API_KEY`) so the script can determine each channel's status
before loading the player.

