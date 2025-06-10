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

## Check live streams

The **Check Live Streams** button queries the YouTube Data API to see which
channels in `canals.json` are broadcasting live. To use it you must provide your
own API key:

1. Create a project in the Google Cloud Console and enable the *YouTube Data API v3*.
2. Generate an API key and copy it into `canal.js` by editing the `API_KEY`
   constant.
3. Reload the page and press **Check Live Streams**.

Only public live streams will be returned; unlisted broadcasts won't appear in
the results.

## Updating channel list

1. Install dependencies with `npm install`.
2. Run `npm run fetch-channels` to scrape the YouTube channel IDs and update `canals.json`.

