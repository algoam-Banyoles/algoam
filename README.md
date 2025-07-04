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

The **Check Live Streams** button (handled by `canal.js`) looks for live broadcasts among the channels

listed in `canals.json`. Each channel entry includes a `handle` (e.g.
`@mychannel`) in addition to its `channelId`. The script first issues a light
`HEAD` request to each channel's `/live` page using the handle when available.
  If a redirect to `/watch?v=VIDEO_ID` is found the channel is considered live.
  When no redirect is returned the page is fetched with `GET` and the video ID is
  extracted from the final URL or HTML. If an `API_KEY` is configured the
  candidate video is verified through the Data API before being listed so that
  only actual live broadcasts appear in the results. This keeps quota usage low
  while avoiding false positives. If the `/live` page yields no video the script
  now falls back to the YouTube Data API search endpoint to look for ongoing
  streams on that channel.

The results of each check are cached for five minutes in `localStorage` so the
same channel isn't queried repeatedly. You can adjust this duration by editing
the `CACHE_TTL` constant in `canal.js`. Verification with the Data API can be
disabled by setting `VERIFY_WITH_API` to `false`.


When a live stream is found it appears in a list under the button. Each result
includes a **Copiar** button that places the live URL into the first empty video
field of the form so you can easily load it. The link text shows the channel
name from `canals.json` so you know which channel is live at a glance.


To use the Data API method you need your own key:

1. Create a project in the Google Cloud Console and enable the *YouTube Data API v3*.
2. Edit `config.js` (included with a placeholder key) and set your API key inside the file.
3. If requests to YouTube return 403 errors, set `CORS_PROXY` in `config.js` to a CORS proxy you control.
4. Reload the page and press **Check Live Streams**.

Only public live streams will be returned; unlisted broadcasts won't appear in
the results.

### Command line usage

This project requires **Node.js 18** or newer to run the command line scripts.

You can also check live streams from the terminal. The command
`npm run check-live` applies the same logic: it first sends a `HEAD` request to
each `/live` page and, if no redirect is present, falls back to a regular fetch
to extract the video ID. When an API key is available the script confirms
through the Data API that the video is currently live before reporting it. The
script prints a status line for each channel, for example:

```
OK MyChannel en emissió: https://www.youtube.com/watch?v=abc123defgh
KO OtherChannel sense emissió
```

Provide your API key via a `config.js` file or the `API_KEY` environment
variable:

```bash
API_KEY=YOUR_KEY npm run check-live
```

## Updating channel list

1. Install dependencies with `npm install`.
2. Run `npm run fetch-channels` to scrape YouTube channels and update `canals.json` with their IDs and handles.

## WebSub listener

The `websub_server.js` script subscribes to a channel's WebSub feed and logs a
message whenever a live stream starts. Set the environment variables
`CHANNEL_ID`, `API_KEY` and `CALLBACK_URL` before running it:

```bash
CHANNEL_ID=UC... API_KEY=YOUR_KEY CALLBACK_URL=https://example.com/websub \
  node websub_server.js
```

The script listens on `PORT` (default `3000`) and automatically subscribes to
the YouTube hub. Whenever a notification arrives it checks the video ID through
the YouTube Data API and prints a line if the broadcast is live.
Using this listener helps avoid polling the API yourself.





## Troubleshooting

If you see repeated `403 (Forbidden)` errors in the browser console when pressing **Check Live Streams**, the default proxy `https://corsproxy.io/` may be blocking requests to YouTube. Edit `config.js` and set the `CORS_PROXY` value to a proxy you control or one that allows requests to YouTube.
