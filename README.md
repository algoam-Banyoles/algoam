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
If the response redirects to `/watch?v=VIDEO_ID` the channel is considered live
and, when an `API_KEY` is configured, a `videos.list` call retrieves the stream
details. Channels that are not live do not trigger any API request, minimising
quota usage.

When a live stream is found it appears in a list under the button. Each result
includes a **Copiar** button that places the live URL into the first empty video
field of the form so you can easily load it.


To use the Data API method you need your own key:

1. Create a project in the Google Cloud Console and enable the *YouTube Data API v3*.
2. Generate an API key and copy it into `canal.js` by editing the `API_KEY`
   constant.
3. Reload the page and press **Check Live Streams**.

Only public live streams will be returned; unlisted broadcasts won't appear in
the results.

### Command line usage

This project requires **Node.js 18** or newer to run the command line scripts.

You can also check live streams from the terminal. The command
`npm run check-live` applies the same logic: it issues a `HEAD` request to each
`/live` page and only consults the Data API when a redirect reveals an active
stream. It prints a status line for each channel, for example:

```
OK MyChannel en emissió: https://www.youtube.com/watch?v=abc123defgh
KO OtherChannel sense emissió
```

An API key is bundled in the project. You can override it by setting the
`API_KEY` environment variable if desired:

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




