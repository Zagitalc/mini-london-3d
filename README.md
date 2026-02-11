# Mini London 3D

A real-time 3D digital map of London's public transport system.

This project is a fork of [Mini Tokyo 3D](https://github.com/nagix/mini-tokyo-3d).

See local London demo via `http://localhost:3000/?city=london`.

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
npm run build:london
npm run serve
```

Then open:

`http://localhost:3000/?city=london`

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

## License

MIT License - see the [LICENSE](LICENSE) file for details.

## Credits

This project is a fork of Mini Tokyo 3D by Akihiko Kusanagi.

Special thanks to:

- TfL (Transport for London) for providing API data
