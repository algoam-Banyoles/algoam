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

The **Check Live Streams** button looks for live broadcasts among the channels
listed in `canals.json`. Each entry must specify its YouTube `@handle` in
addition to the `channelId`; the fallback detection relies on visiting
`youtube.com/@handle/live`. If the `API_KEY` constant in `canal.js` is set the
script uses the YouTube Data API. Otherwise it falls back to checking each
channel's `/live` page—preferring the handle when available—through a CORS
proxy.

To use the Data API method you need your own key:

1. Create a project in the Google Cloud Console and enable the *YouTube Data API v3*.
2. Generate an API key and copy it into `canal.js` by editing the `API_KEY`
   constant.
3. Reload the page and press **Check Live Streams**.

Only public live streams will be returned; unlisted broadcasts won't appear in
the results.

### Command line usage

You can also check live streams from the terminal. Run
`npm run check-live` and the script will print the watch URLs of any channels
currently broadcasting live. Set the `API_KEY` environment variable if you want
to use the YouTube Data API:

```bash
API_KEY=YOUR_KEY npm run check-live
```

## Updating channel list

1. Install dependencies with `npm install`.
2. Run `npm run fetch-channels` to scrape YouTube channels and update
   `canals.json` with their IDs and handles. The script fetches each channel's
   page when necessary to ensure every entry includes a handle.

