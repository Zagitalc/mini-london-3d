// Central configuration for mini-tokyo-3d.
//
// NOTE:
// This file must export a *default* object (many modules import `configs` as default)
// and it must also export `langs` as a named export (some modules may import it
// via namespace imports during development).

// Supported UI languages (must match the shipped dictionary-*.json files)
export const langs = [
    'en',
    'ja',
    'ko',
    'zh-Hans',
    'zh-Hant',
    'fr',
    'de',
    'es',
    'pt-BR',
    'th',
    'ne'
];

const configs = {
    // City selector (Tokyo is the original default)
    city: 'tokyo',

    // Language options
    langs,

    // Default data root (Map overrides this at runtime for localhost/London)
    dataUrl: 'https://minitokyo3d.com/data',

    // Credit for the upstream Mini Tokyo 3D project
    customAttribution: '<a href="https://github.com/nagix/mini-tokyo-3d">© Akihiko Kusanagi</a>',

    // Rendering defaults
    defaultEcoMode: 'normal',
    defaultEcoFrameRate: 30,

    // Periodic refreshes use simulation time, never the display frame rate.
    minDelay: 25000,
    refreshInterval: 60000,
    realtimeCheckInterval: 15000,
    refreshTimeout: 10000,

    // Realtime backends used only by the original Tokyo deployment.
    tidUrl: 'https://mini-tokyo.appspot.com/tid',
    trainInfoUrl: 'https://mini-tokyo.appspot.com/traininfo',
    atisUrl: 'https://mini-tokyo.appspot.com/atisinfo',
    flightUrl: 'https://mini-tokyo.appspot.com/flight'
};

export default configs;
