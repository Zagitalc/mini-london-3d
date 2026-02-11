const TFL_LINE_COLORS = {
    bakerloo: '#B36305',
    central: '#E32017',
    circle: '#FFD300',
    district: '#00782A',
    'hammersmith-city': '#F3A9BB',
    jubilee: '#A0A5A9',
    metropolitan: '#9B0056',
    northern: '#000000',
    piccadilly: '#003688',
    victoria: '#0098D4',
    'waterloo-city': '#95CDBA'
};

function getTfLLineId(params) {
    const lineId = params.lineId || String(params.id || '').replace(/^tfl\./, '').split('.')[0];
    return String(lineId || '').toLowerCase();
}

function resolveRailwayColor(params) {
    const lineId = getTfLLineId(params);
    const mapped = TFL_LINE_COLORS[lineId];
    const color = (params.color || '').trim();

    if (!mapped) {
        return color || '#0098D4';
    }
    if (!color) {
        return mapped;
    }

    // Older generated London data can have Victoria blue for every line.
    if (color.toUpperCase() === '#0098D4' && lineId !== 'victoria') {
        return mapped;
    }

    return color;
}

export default class {

    /*
        Other properties:

        status;
        text;
        suspended;
    */

    constructor(params, refs) {
        const me = this,
            {dynamic, altitude} = params;

        /**
         * Railway ID.
         * @type {string}
         */
        me.id = params.id;

        /**
         * Base TfL line id (e.g. "central") for branched railways.
         * @type {string}
         */
        if (params.lineId) {
            me.lineId = params.lineId;
        }

        /**
         * Multilingual railway title.
         * @type {Object}
         */
        me.title = params.title;

        /**
         * Railway stations.
         * @type {Array<Station>}
         */
        me.stations = params.stations.map(id => refs.stations.getOrAdd(id));

        /**
         * Ascending rail direction.
         * @type {RailDirection}
         */
        me.ascending = refs.railDirections.get(params.ascending);

        /**
         * Descending rail direction.
         * @type {RailDirection}
         */
        me.descending = refs.railDirections.get(params.descending);

        if (altitude) {
            /**
             * Railway altitude.
             * @type {number}
             */
            me.altitude = altitude;
        }

        /**
         * Railway color.
         * @type {string}
         */
        me.color = resolveRailwayColor(params);

        /**
         * Railway car composition.
         * @type {number}
         */
        me.carComposition = params.carComposition;

        if (dynamic) {
            /**
             * If true, trains appear and disappear dynamically based on train information.
             * @type {boolean}
             */
            me.dynamic = dynamic;
        }
    }

}
