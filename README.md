# Mini London 3D

A real-time 3D digital map of London's public transport system.

This project is a fork of [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d).

See local London demo via `http://localhost:3000/?city=london`.

## Current London UI

The London build now includes a London-specific control shell on top of the existing map rendering and train animation systems.

- `Line Status` overlay for network-wide service updates
- `Search & Filter` panel for station lookup and line filtering
- station detail drawer on normal click/tap
- light/dark theme toggle in the header
- graceful no-data states when TfL arrivals or crowding data are unavailable

## About Data

Primary sources used in this fork:

- Transport for London (TfL) API for live arrivals and line data
- OpenStreetMap/Mapbox data for basemap and building geometry
- Local curated London geometry files in `data-london/`

## Local Setup

Requirements:

- Node.js 20+ (recommended)
- npm
- Mapbox access token
- TfL API key (and optional app id)

Install dependencies:

```bash
npm install
```

Configure runtime keys for browser demo (`public/config.local.js`):

```js
window.MT3D_CONFIG = {
    accessToken: 'pk.your_mapbox_token',
    secrets: {
        tflAppKey: 'your_tfl_app_key',
        // optional:
        tflAppId: 'your_tfl_app_id',
        // optional proxy if you use one:
        // tflProxyBase: 'https://your-proxy.example.com/'
    }
};
```

Build and run London:

```bash
npm start
```

Then open:

`http://localhost:3000/?city=london`

`npm start` rebuilds the London app and serves the local demo in one command.

If you already built once and only want to serve the generated output again:

```bash
npm run serve
```

## Optional Environment Variables (for data scripts)

Some scripts read env vars directly (for example TfL fetch scripts and London data loader):

- `TFL_APP_KEY`
- `TFL_APP_ID` (optional)
- `MT3D_CITY` (used in build-data scripts)
- `MT3D_DATA_DIR` (used in build-data scripts)

Example:

```bash
export TFL_APP_KEY=your_tfl_app_key
export TFL_APP_ID=your_tfl_app_id
npm run build-data:london
```

## Notes

- London defaults to the English UI unless `?lang=` is explicitly provided.
- The page metadata is set to English for the London build to avoid browser auto-translate prompts.
- TfL live arrivals can occasionally return empty data; when that happens the station drawer will explicitly show that live arrivals or crowding data are unavailable instead of using fake placeholder data.

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

This project is a fork of Mini Tokyo 3D by Akihiko Kusanagi.

Special thanks to:

- TfL (Transport for London) for providing API data
