import { featureEach } from '@turf/meta';
import { Evented, FullscreenControl, LngLat, LngLatBounds, Map as Mapbox, MercatorCoordinate, NavigationControl } from 'mapbox-gl';
import AnimatedPopup from 'mapbox-gl-animated-popup';
import animation from './animation';
import Clock from './clock';
import configs from './configs';
import { ClockControl, MapboxGLButtonControl, SearchControl } from './controls';
import Dataset from './dataset';
import { Airport, Flight, FlightStatus, Operator, POI, RailDirection, Railway, Station, Train, TrainTimetables, TrainType, TrainVehicleType } from './data-classes';
import extend from './extend';
import * as helpers from './helpers/helpers';
import { pickObject } from './helpers/helpers-deck';
import * as helpersGeojson from './helpers/helpers-geojson';
import * as helpersMapbox from './helpers/helpers-mapbox';
import { GeoJsonLayer, ThreeLayer, Tile3DLayer, TrafficLayer } from './layers';
import { loadBusData, loadDynamicBusData, loadDynamicFlightData, loadDynamicTrainData, loadStaticData, loadTimetableData, updateOdptUrl } from './loader';
import { AboutPanel, BusPanel, LayerPanel, SharePanel, StationPanel, TrainPanel } from './panels';
import Plugin from './plugin';
import nearestCloserPointOnLine from './turf/nearest-closer-point-on-line';

const RAILWAY_NAMBOKU = 'TokyoMetro.Namboku',
    RAILWAY_MITA = 'Toei.Mita',
    RAILWAY_ARAKAWA = 'Toei.Arakawa';

const AIRLINES_FOR_ANA_CODE_SHARE = ['ADO', 'SFJ', 'SNJ'];
const LONDON_DEFAULT_SEGMENT_SPEED_KM_PER_SEC = 0.012;
const LONDON_OVERLAP_PROGRESS_SPACING = 0.02;

const DEGREE_TO_RADIAN = Math.PI / 180;

// Replace NavigationControl._updateZoomButtons to support disabling the control
const _updateZoomButtons = NavigationControl.prototype._updateZoomButtons;
NavigationControl.prototype._updateZoomButtons = function () {
    const me = this,
        { _disabled, _zoomInButton, _zoomOutButton, _compass } = me;
    _updateZoomButtons.apply(me);

    if (_disabled) {
        _zoomInButton.disabled = _zoomOutButton.disabled = true;
        _zoomInButton.setAttribute('aria-disabled', 'true');
        _zoomOutButton.setAttribute('aria-disabled', 'true');
    }
    _compass.disabled = !!_disabled;
    _compass.setAttribute('aria-disabled', (!!_disabled).toString());
};

NavigationControl.prototype.enable = function () {
    const me = this;

    delete me._disabled;
    me._updateZoomButtons();
};

NavigationControl.prototype.disable = function () {
    const me = this;

    me._disabled = true;
    me._updateZoomButtons();
};

export default class extends Evented {

    constructor(options) {
        super();

        const me = this;

        options = extend({
            hash: false,
            useWebGL2: true,
            center: configs.defaultCenter,
            zoom: configs.defaultZoom,
            bearing: configs.defaultBearing,
            pitch: configs.defaultPitch,
            dataUrl: configs.dataUrl,
            dataSources: configs.dataSources,
            clockControl: true,
            searchControl: true,
            navigationControl: true,
            fullscreenControl: true,
            modeControl: true,
            configControl: true,
            trackingMode: configs.defaultTrackingMode,
            ecoMode: configs.defaultEcoMode,
            ecoFrameRate: configs.defaultEcoFrameRate
        }, options);

        me.lang = helpers.getLang(options.lang);

        // Determine city from URL (e.g. ?city=london). Fall back to configs.city.
        const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
        const city = (qs && qs.get('city')) || configs.city;
        me.city = city;
        const defaultCenter = configs.defaultCenter;
        let hasCustomCenter = false;
        if (Array.isArray(options.center) && Array.isArray(defaultCenter)) {
            hasCustomCenter = options.center.length !== defaultCenter.length ||
                !options.center.every((value, index) => value === defaultCenter[index]);
        }
        me._lockModelOrigin = city === 'london' && hasCustomCenter;
        me.useLondonLiveTrains = city === 'london'
            ? true
            : (options.useLondonLiveTrains !== undefined ? options.useLondonLiveTrains : false);
        me.useLondonLiveTrains3d = city === 'london'
            ? true
            : (options.useLondonLiveTrains3d !== undefined ? options.useLondonLiveTrains3d : false);

        // Ensure Mercator projection for custom 3D layers (London trains)
        if (city === 'london' && !options.projection) {
            options.projection = 'mercator';
        }

        // Use local build data when running London (or localhost), otherwise use default dataUrl.
        if (city === 'london' || (typeof location !== 'undefined' && location.hostname === 'localhost')) {
            const path = typeof location !== 'undefined' ? location.pathname : '';
            const servingBuildDir = /(^|\/)build(\/|$)/.test(path);
            me.dataUrl = servingBuildDir ? 'build/data' : 'data';
        } else {
            me.dataUrl = options.dataUrl;
        }

        const secrets = options.secrets || {};
        const dataSources = Array.isArray(options.dataSources) ? options.dataSources : [];

        me.dataSources = dataSources.map(({ gtfsUrl, vehiclePositionUrl, color }) => ({
            gtfsUrl: updateOdptUrl(gtfsUrl, secrets),
            vehiclePositionUrl: updateOdptUrl(vehiclePositionUrl, secrets),
            color
        }));
        me.container = typeof options.container === 'string' ?
            document.getElementById(options.container) : options.container;
        me.secrets = secrets;
        me.modelOrigin = MercatorCoordinate.fromLngLat(options.center);
        me.exitPopups = [];

        me.clockControl = options.clockControl;
        me.searchControl = options.searchControl;
        me.navigationControl = options.navigationControl;
        me.fullscreenControl = options.fullscreenControl;
        me.modeControl = options.modeControl;
        me.configControl = options.configControl;
        me.clock = new Clock();
        me.plugins = (options.plugins || []).map(plugin => new Plugin(plugin));

        me.searchMode = 'none';
        me.viewMode = configs.defaultViewMode;
        me.trackingMode = options.trackingMode;
        me.trackingParams = {
            zoom: {},
            bearing: {},
            pitch: {}
        };
        me.lastCameraParams = {};
        me.initialSelection = options.selection;
        me.clockMode = options.clockMode ||
            configs.defaultClockMode ||
            (city === 'london' ? 'playback' : 'realtime');
        me.isEditingTime = false;
        me.ecoMode = options.ecoMode;
        me.ecoFrameRate = options.ecoFrameRate;

        me.lastDynamicUpdate = {};
        me.lastRepaint = 0;
        me.frameRateFactor = 1;

        // The inner map container overrides the option
        options.container = initContainer(me.container);

        // This style overrides the option
        // Use Tokyo style by default, but allow a cleaner base style for London.
        // (London currently renders its own fallback layers on top.)
        options.style = (me.city === 'london')
            ? 'mapbox://styles/mapbox/light-v11'
            : 'assets/style.json';

        // The custom attribution will be appended only if ConfigControl is visible
        if (!options.configControl) {
            options.customAttribution = helpers.flat([options.customAttribution, configs.customAttribution]);
        }

        me.map = new Mapbox(options);

        for (const event of (configs.events || [])) {
            me.map.on(event, me.fire.bind(me));
        }

        me.map.once('idle', () => {
            helpers.measureFrameRate().then(frameRate => {
                me.frameRateFactor = Math.min(60 / frameRate, 2);
            });
        });

        const clockPromise = options.center === configs.defaultCenter ?
            new Promise(resolve => resolve(me.clock)) :
            helpersMapbox.fetchTimezoneOffset(options.center, options.accessToken)
                .then(offset => me.clock.setTimezoneOffset(offset));

        Promise.all([
            loadStaticData(me.dataUrl, me.lang, clockPromise, me.city)
                .then(me.initData.bind(me))
                .catch(error => {
                    showErrorMessage(me.container);
                    throw error;
                }),
            new Promise(resolve => {
                me.map.once('styledata', resolve);
            })
        ]).then(me.initialize.bind(me));

        clockPromise.then(() => {
            me.gtfs = new Map();
            me.refreshBusData();
        });
    }

    /**
     * Returns the Mapbox's Map object used in the map.
     * @returns {mapboxgl.Map} The Mapbox's Map
     */
    getMapboxMap() {
        return this.map;
    }

    /**
     * Returns the current city (from URL querystring if present).
     * @returns {string}
     */
    getCityFromLocation() {
        return this.city || configs.city;
    }

    /**
     * Returns the map's geographical centerpoint.
     * @returns {LngLat} The map's geographical centerpoint
     */
    getCenter() {
        return this.map.getCenter();
    }

    /**
     * Sets the map's geographical centerpoint. Equivalent to jumpTo({center: center}).
     * @param {LngLatLike} center - The centerpoint to set
     * @returns {Map} Returns itself to allow for method chaining
     */
    setCenter(center) {
        const me = this;

        me.trackObject();
        me.map.setCenter(center);
        return me;
    }

    /**
     * Returns the map's current zoom level.
     * @returns {number} The map's current zoom level
     */
    getZoom() {
        return this.map.getZoom();
    }

    /**
     * Sets the map's zoom level. Equivalent to jumpTo({zoom: zoom}).
     * @param {number} zoom - The zoom level to set (0-20)
     * @returns {Map} Returns itself to allow for method chaining
     */
    setZoom(zoom) {
        const me = this;

        me.map.setZoom(zoom);
        return me;
    }

    /**
     * Returns the map's current bearing. The bearing is the compass direction that
     * is "up"; for example, a bearing of 90° orients the map so that east is up.
     * @returns {number} The map's current bearing
     */
    getBearing() {
        return this.map.getBearing();
    }

    /**
     * Sets the map's bearing (rotation). The bearing is the compass direction that
     * is "up"; for example, a bearing of 90° orients the map so that east is up.
     * Equivalent to jumpTo({bearing: bearing}).
     * @param {number} bearing - The desired bearing
     * @returns {Map} Returns itself to allow for method chaining
     */
    setBearing(bearing) {
        const me = this;

        me.trackObject();
        me.map.setBearing(bearing);
        return me;
    }

    /**
     * Returns the map's current pitch (tilt).
     * @returns {number} The map's current pitch, measured in degrees away from the
     *     plane of the screen
     */
    getPitch() {
        return this.map.getPitch();
    }

    /**
     * Sets the map's pitch (tilt). Equivalent to jumpTo({pitch: pitch}).
     * @param {number} pitch - The pitch to set, measured in degrees away from the
     *     plane of the screen (0-60)
     * @returns {Map} Returns itself to allow for method chaining
     */
    setPitch(pitch) {
        const me = this;

        me.map.setPitch(pitch);
        return me;
    }

    /**
     * Changes any combination of center, zoom, bearing, pitch, and padding with an
     * animated transition between old and new values. The map will retain its current
     * values for any details not specified in options.
     * @param {Object} options - Options describing the destination and animation of
     *     the transition. Accepts CameraOptions and AnimationOptions
     * @returns {Map} Returns itself to allow for method chaining
     */
    easeTo(options) {
        const me = this;

        if (options.center !== undefined || options.bearing !== undefined) {
            me.trackObject();
        }
        me.map.easeTo(options);
        return me;
    }

    /**
     * Changes any combination of center, zoom, bearing, and pitch, animating the
     * transition along a curve that evokes flight. The animation seamlessly incorporates
     * zooming and panning to help the user maintain her bearings even after traversing
     * a great distance.
     * @param {Object} options - Options describing the destination and animation of
     *     the transition. Accepts CameraOptions, AnimationOptions, and a few additional
     *     options
     * @returns {Map} Returns itself to allow for method chaining
     */
    flyTo(options) {
        const me = this;

        if (options.center !== undefined || options.bearing !== undefined) {
            me.trackObject();
        }
        me.map.flyTo(options);
        return me;
    }

    /**
     * Changes any combination of center, zoom, bearing, and pitch, without an animated
     * transition. The map will retain its current values for any details not specified
     * in options.
     * @param {CameraOptions} options - Options object
     * @returns {Map} Returns itself to allow for method chaining
     */
    jumpTo(options) {
        const me = this;

        if (options.center !== undefined || options.bearing !== undefined) {
            me.trackObject();
        }
        me.map.jumpTo(options);
        return me;
    }

    /**
     * Returns the current view mode.
     * @returns {string} Current view mode: 'ground' or 'underground'
     */
    getViewMode() {
        return this.viewMode;
    }

    /**
     * Sets the view mode.
     * @param {string} mode - View mode: 'ground' or 'underground'
     * @returns {Map} Returns itself to allow for method chaining
     */
    setViewMode(mode) {
        const me = this;

        if (me.initialized) {
            me._setViewMode(mode);
        }
        return me;
    }

    /**
     * Returns the current tracking mode.
     * @returns {string} Current tracking mode: 'position', 'back', 'topback', 'front',
     *     'topfront', 'helicopter', 'drone', 'bird' or 'heading'
     */
    getTrackingMode() {
        return this.trackingMode;
    }

    /**
     * Sets the tracking mode.
     * @param {string} mode - Tracking mode: 'position', 'back', 'topback', 'front',
     *     'topfront', 'helicopter', 'drone', 'bird' or 'heading'
     * @returns {Map} Returns itself to allow for method chaining
     */
    setTrackingMode(mode) {
        const me = this;

        me._setTrackingMode(mode);
        return me;
    }

    /**
     * Returns the ID of the train or flight being tracked, or the IDs of the selected
     * stations.
     * @returns {string | Array<string>} The ID of the train or flight being tracked, or
     *     the IDs of the selected stations
     */
    getSelection() {
        const trackedObject = this.trackedObject;

        if (isVehicle(trackedObject)) {
            return trackedObject.id;
        } else if (isStation(trackedObject)) {
            return trackedObject.stations;
        }
    }

    /**
     * Sets the ID of the train or flight you want to track, or the station to select.
     * @param {string} id - ID of the train or flight to be tracked, or the station to
     *     be selected
     * @returns {Map} Returns itself to allow for method chaining
     */
    setSelection(id) {
        const me = this,
            selection = helpers.removePrefix(id),
            station = me.stations.get(selection);

        if (station) {
            me.trackObject(me.stationGroupLookup.get(station.group));
            delete me.initialSelection;
        } else if (!selection.match(/NRT|HND/)) {
            if (me.trainLoaded) {
                let activeTrain;

                for (const id of me.timetables.getConnectingTrainIds(selection)) {
                    if ((activeTrain = me.activeTrainLookup.get(id))) {
                        break;
                    }
                }
                if (activeTrain) {
                    me.trackObject(activeTrain);
                } else {
                    helpers.showNotification(me.container, me.dict['train-terminated']);
                }
                delete me.initialSelection;
            } else {
                me.initialSelection = selection;
            }
        } else {
            if (me.flightLoaded) {
                const activeFlight = me.activeFlightLookup.get(selection);

                if (activeFlight) {
                    me.trackObject(activeFlight);
                } else {
                    helpers.showNotification(me.container, me.dict['flight-terminated']);
                }
                delete me.initialSelection;
            } else {
                me.initialSelection = selection;
            }
        }

        return me;
    }

    /**
     * Returns the current clock mode.
     * @returns {string} Current clock mode: 'realtime' or 'playback'
     */
    getClockMode() {
        return this.clockMode;
    }

    /**
     * Sets the clock mode.
     * @param {string} mode - Clock mode: 'realtime' or 'playback'
     * @returns {Map} Returns itself to allow for method chaining
     */
    setClockMode(mode) {
        const me = this;

        if (me.initialized) {
            me._setClockMode(mode);
        }
        return me;
    }

    /**
     * Returns the current eco mode.
     * @returns {string} Current eco mode: 'normal' or 'eco'
     */
    getEcoMode() {
        return this.ecoMode;
    }

    /**
     * Sets the eco mode.
     * @param {string} mode - Eco mode: 'normal' or 'eco'
     * @returns {Map} Returns itself to allow for method chaining
     */
    setEcoMode(mode) {
        const me = this;

        me._setEcoMode(mode);
        return me;
    }

    /**
     * Adds a layer to the map.
     * @param {Object | CustomLayerInterface | GeoJsonLayerInterface | ThreeLayerInterface | Tile3DLayerInterface} layer
     *     - The layer to add, conforming to either the Mapbox Style Specification's
     *     layer definition, the CustomLayerInterface specification, the
     *     GeoJsonLayerInterface specification, the ThreeLayerInterface specification
     *     or the Tile3DLayerInterface specification
     * @param {string} beforeId - The ID of an existing layer to insert the new
     *     layer before
     * @returns {Map} Returns itself to allow for method chaining
     */
    addLayer(layer, beforeId) {
        const me = this;

        if (layer.type === 'three') {
            new ThreeLayer(layer).onAdd(me, beforeId);
        } else if (layer.type === 'geojson') {
            new GeoJsonLayer(layer).onAdd(me, beforeId);
        } else if (layer.type === 'tile-3d') {
            new Tile3DLayer(layer).onAdd(me, beforeId);
        } else {
            me.map.addLayer(layer, beforeId || 'poi');
        }
        return me;
    }

    /**
     * Removes the layer with the given ID from the map.
     * @param {string} id - ID of the layer to remove
     * @returns {Map} Returns itself to allow for method chaining
     */
    removeLayer(id) {
        const me = this;

        me.map.removeLayer(id);
        return me;
    }

    /**
     * Sets the visibility of the layer.
     * @param {string} layerId - The ID of the layer to set the visibility in.
     * @param {string} visibility - Whether this layer is displayed.
     *     'visible' and 'none' are supported.
     * @returns {Map} Returns itself to allow for method chaining
     */
    setLayerVisibility(layerId, visibility) {
        const me = this;

        me.map.setLayoutProperty(layerId, 'visibility', visibility);
        return me;
    }

    /**
     * Returns a MercatorCoordinate object that represents the initial centerpoint
     * of the map as the origin of the mercator coordinates.
     * @returns {MercatorCoordinate} The origin of the mercator coordinates
     */
    getModelOrigin() {
        return this.modelOrigin;
    }

    /**
     * Returns the scale to transform into MercatorCoordinate from coordinates in
     * real world units using meters. This provides the distance of 1 meter in
     * MercatorCoordinate units at the initial centerpoint of the map.
     * @returns {number} The scale to transform into MercatorCoordinate from
     *     coordinates in real world units using meters
     */
    getModelScale() {
        return this.modelOrigin.meterInMercatorCoordinateUnits();
    }

    /**
     * Projects a LngLat to a MercatorCoordinate, and returns the translated
     * mercator coordinates with the initial centerpoint of the map as the origin.
     * @param {LngLatLike} lnglat - The location to project
     * @param {number} altitude - The altitude in meters of the position
     * @returns {Object} The translated mercator coordinates with the initial
     *     centerpoint of the map as the origin
     */
    getModelPosition(lnglat, altitude) {
        const me = this,
            coord = MercatorCoordinate.fromLngLat(lnglat, altitude);

        return {
            x: coord.x - me.modelOrigin.x,
            y: -(coord.y - me.modelOrigin.y),
            z: coord.z - me.modelOrigin.z
        };
    }

    /**
     * Checks if the background color of the map is dark.
     * @returns {boolean} True if the background color of the map is dark
     */
    hasDarkBackground() {
        return helpersMapbox.hasDarkBackground(this.map);
    }

    setDataSources(dataSources) {
        const me = this;

        me.dataSources = dataSources.map(({ gtfsUrl, vehiclePositionUrl, color }) => ({
            gtfsUrl: updateOdptUrl(gtfsUrl, me.secrets),
            vehiclePositionUrl: updateOdptUrl(vehiclePositionUrl, me.secrets),
            color
        }));
        me.refreshBusData();
    }

    initData(data) {
        const me = this,
            featureLookup = me.featureLookup = new Map(),
            stationGroupLookup = me.stationGroupLookup = new Map();

        me.dict = data.dict;
        me.featureCollection = data.featureCollection;

        me.stations = new Dataset(Station);
        me.railDirections = new Dataset(RailDirection, data.railDirectionData);
        me.railways = new Dataset(Railway, data.railwayData, {
            stations: me.stations,
            railDirections: me.railDirections
        });
        me.pois = new Dataset(POI, data.poiData);
        me.stations.load(data.stationData, {
            stations: me.stations,
            railways: me.railways,
            railDirections: me.railDirections,
            pois: me.pois
        });

        // Build feature lookup dictionary and update feature properties
        featureEach(me.featureCollection, feature => {
            const properties = feature.properties,
                { group, altitude } = properties;

            if (properties.type === 1) {
                // stations
                featureLookup.set(`${group}.${properties.zoom}`, feature);
                if (!stationGroupLookup.has(group)) {
                    stationGroupLookup.set(group, {
                        id: group,
                        type: 'station',
                        stations: properties.ids.map(id => me.stations.get(id)),
                        layer: altitude === 0 ? 'ground' : 'underground'
                    });
                }
            } else if (!(altitude <= 0)) {
                // airways and railways (no railway sections)
                featureLookup.set(properties.id, feature);
                helpersGeojson.updateDistances(feature);
            }
        });

        for (const station of me.stations.getAll()) {
            if (station.alternate) {
                for (const layer of ['og', 'ug']) {
                    const key = station.group.replace(/.g$/, layer),
                        stationGroup = stationGroupLookup.get(key);

                    if (stationGroup) {
                        if (!stationGroup.hidden) {
                            stationGroup.hidden = [];
                        }
                        stationGroup.hidden.push(station);
                    }
                }
            }
        }

        me.trainTypes = new Dataset(TrainType, data.trainTypeData);
        me.trainVehicleTypes = new Dataset(TrainVehicleType, data.trainVehicleData);

        me.lastTimetableRefresh = me.clock.getTime('03:00');
        me.dataReferences = {
            railways: me.railways,
            stations: me.stations,
            railDirections: me.railDirections,
            trainTypes: me.trainTypes,
            trainVehicleTypes: me.trainVehicleTypes
        };
        me.timetables = new TrainTimetables(data.timetableData, me.dataReferences);

        me.operators = new Dataset(Operator, data.operatorData);
        me.airports = new Dataset(Airport, data.airportData);
        me.flightStatuses = new Dataset(FlightStatus, data.flightStatusData);

        me.activeTrainLookup = new Map();
        me.standbyTrainLookup = new Map();
        me.realtimeTrains = new Set();
        me.adTrains = new Set();
        me.activeFlightLookup = new Map();
        me.flightLookup = new Map();

        if (me.getCityFromLocation() === 'london' && me.featureCollection && !me._lockModelOrigin) {
            const bounds = new LngLatBounds();
            featureEach(me.featureCollection, feature => {
                if (!feature || !feature.geometry) return;
                const { type, coordinates } = feature.geometry;
                if (type === 'Point' && Array.isArray(coordinates)) {
                    bounds.extend(coordinates);
                } else if (type === 'LineString' && Array.isArray(coordinates)) {
                    for (const coord of coordinates) bounds.extend(coord);
                } else if (type === 'MultiLineString' && Array.isArray(coordinates)) {
                    for (const line of coordinates) {
                        for (const coord of line) bounds.extend(coord);
                    }
                }
            });
            if (!bounds.isEmpty()) {
                me.modelOrigin = MercatorCoordinate.fromLngLat(bounds.getCenter());
            }
        }
    }

    initialize() {
        const me = this,
            { lang, dict, clock, map, container, featureCollection } = me,
            initialZoom = map.getZoom(),
            layerZoom = me.layerZoom = getLayerZoom(initialZoom);

        // Expose the Map instance for DevTools debugging
        if (typeof window !== 'undefined') {
            window.__mt3d = me;
        }

        if (map.loaded()) {
            hideLoader(container);
        } else {
            map.once('load', () => {
                hideLoader(container);
            });
        }

        // Deprecated
        // me.objectUnit = Math.max(getObjectScale(initialZoom) * .19, .02);

        const isLondon = me.getCityFromLocation() === 'london';
        const hasLondonRoutes = isLondon && me.featureCollection && (me.featureCollection.features || []).length > 0;
        const useLondonLiveTrains3d = isLondon && me.useLondonLiveTrains && me.useLondonLiveTrains3d;
        const enableTrafficLayer = !isLondon || (hasLondonRoutes && (!me.useLondonLiveTrains || useLondonLiveTrains3d));

        // TrafficLayer (deck.gl compute/WebGL) requires full route/features datasets.
        // London mode uses a safe no-op stub unless features/timetables are available.
        if (enableTrafficLayer) {
            me.trafficLayer = new TrafficLayer({ id: 'traffic' });
        } else {
            me.trafficLayer = {
                // Methods used throughout the codebase
                setTimeOffset() { },
                refreshDelayMarkers() { },
                addRouteGroup() { },
                addColorGroup() { },
                addObject() { },
                updateObject() { },
                removeObject() { },

                // Used by Map.pickObject() (deck.gl picking). London mode disables TrafficLayer,
                // so just return null to indicate "nothing picked".
                pickObject() { return null; },

                // Used by adjustCoord() fallback path
                project: (lnglat /*, altitude */) => map.project(lnglat)
            };
            console.log('[London] TrafficLayer disabled (live trains or missing features/route datasets)');
        }

        // To move to the style file in v4.0
        map.addLayer({
            id: 'sky',
            type: 'sky',
            paint: {
                'sky-opacity': [
                    'interpolate',
                    ['linear'],
                    ['zoom'],
                    0,
                    0,
                    5,
                    0.3,
                    8,
                    1
                ],
                'sky-type': 'atmosphere',
                'sky-atmosphere-color': 'hsl(220, 100%, 70%)',
                'sky-atmosphere-sun-intensity': 20
            }
        }, 'background');
        helpersMapbox.setSunlight(map, clock.getTime());

        map.setLayoutProperty('poi', 'text-field', [
            'coalesce',
            ['get', `name_${lang}`],
            ['get', 'name_en'],
            ['get', 'name']
        ]);

        for (const zoom of [13, 14, 15, 16, 17, 18]) {
            const commonProps = {
                type: 'geojson',
                lineWidthUnits: 'pixels',
                lineWidthScale:
                    zoom === 13 ? helpers.clamp(Math.pow(2, initialZoom - 12), .125, 1) :
                        zoom === 18 ? helpers.clamp(Math.pow(2, initialZoom - 19), 1, 8) : 1,
                parameters: { depthTest: false },
                minzoom: zoom <= 13 ? 0 : zoom,
                maxzoom: zoom >= 18 ? 24 : zoom + 1
            };

            for (const key of ['marked', 'selected']) {
                me.addLayer(Object.assign({}, commonProps, {
                    id: `stations-${key}-${zoom}`,
                    getLineWidth: 12,
                    getLineColor: [255, 255, 255],
                    getFillColor: [255, 255, 255],
                    visible: false
                }), 'trees');
            }

            for (const key2 of ['ug', 'routeug', 'routeog']) {
                for (const key1 of ['railways', 'stations']) {
                    const type = key1 === 'railways' ? 0 : 1,
                        filter = p => p.zoom === zoom && p.type === type && p.altitude < 0;

                    me.addLayer(Object.assign({}, commonProps, {
                        id: `${key1}-${key2}-${zoom}`,
                        data: key2 === 'ug' ?
                            helpersGeojson.featureFilter(featureCollection, filter) :
                            helpersGeojson.emptyFeatureCollection(),
                        transitions: { opacity: configs.transitionDuration }
                    }, {
                        'railways': {
                            filled: false,
                            getLineWidth: d => d.properties.width,
                            getLineColor: d => helpers.colorToRGBArray(d.properties.color)
                        },
                        'stations': {
                            getLineWidth: 4,
                            getFillColor: [255, 255, 255, 179]
                        }
                    }[key1], {
                        'ug': {
                            opacity: .0625,
                            pickable: key1 === 'stations',
                            metadata: {
                                'mt3d:opacity-effect': true,
                                'mt3d:opacity': 0.0625,
                                'mt3d:opacity-route': 0.005,
                                'mt3d:opacity-underground': 1,
                                'mt3d:opacity-underground-route': 0.005
                            }
                        },
                        'routeug': {
                            opacity: .0625,
                            metadata: {
                                'mt3d:opacity-effect': true,
                                'mt3d:opacity': 0.125,
                                'mt3d:opacity-underground': 1
                            }
                        },
                        'routeog': {
                            metadata: {
                                'mt3d:opacity-effect': true,
                                'mt3d:opacity': 1,
                                'mt3d:opacity-underground': 0.25
                            }
                        }
                    }[key2]), 'trees');
                }
            }
        }

        // Workaround for deck.gl #3522
        map.__deck.props.getCursor = () => map.getCanvas().style.cursor;

        map.addSource('odpt', {
            type: 'geojson',
            data: helpersGeojson.featureFilter(featureCollection, p => p.altitude === 0)
        });

        // London: add a deck.gl rail line layer so 3D trains align with the line at pitch.
        if (isLondon && featureCollection && (featureCollection.features || []).length) {
            for (const zoom of [13, 14, 15, 16, 17, 18]) {
                const lineWidthScale =
                    zoom === 13 ? helpers.clamp(Math.pow(2, initialZoom - 12), .125, 1) :
                        zoom === 18 ? helpers.clamp(Math.pow(2, initialZoom - 19), 1, 8) : 1;
                const lineData = helpersGeojson.featureFilter(featureCollection, p =>
                    p.zoom === zoom && p.type === 0
                );
                if (!lineData.features.length) continue;
                const layerId = `london-railways-3d-${zoom}`;
                me.addLayer({
                    id: layerId,
                    type: 'geojson',
                    data: lineData,
                    filled: false,
                    getLineWidth: d => d.properties.width || 8,
                    getLineColor: d => helpers.colorToRGBArray(d.properties.color || '#0098D4'),
                    lineWidthUnits: 'pixels',
                    lineWidthScale,
                    parameters: { depthTest: false },
                    minzoom: zoom <= 13 ? 0 : zoom,
                    maxzoom: zoom >= 18 ? 24 : zoom + 1
                }, 'trees');
                if (map.getLayer(layerId)) {
                    map.setLayoutProperty(layerId, 'visibility', 'visible');
                }
            }
            me._londonHas3dRailLines = true;
        }



        // London fallback rendering (when features.json etc. are not generated)
        if (me.getCityFromLocation() === 'london') {
            const londonGeo = me.buildLondonRailGeoJSON();

            try {
                // Add/replace a simple GeoJSON source containing railways + stations
                if (map.getSource('london-rail')) {
                    map.getSource('london-rail').setData(londonGeo);
                    if (map.getLayer('london-railways')) map.moveLayer('london-railways');
                    if (map.getLayer('london-stations')) map.moveLayer('london-stations');
                    if (me._londonHas3dRailLines && useLondonLiveTrains3d && map.getLayer('london-railways')) {
                        map.setLayoutProperty('london-railways', 'visibility', 'none');
                    } else if (map.getLayer('london-railways')) {
                        map.setLayoutProperty('london-railways', 'visibility', 'visible');
                    }
                } else {
                    map.addSource('london-rail', {
                        type: 'geojson',
                        data: londonGeo
                    });

                    map.addLayer({
                        id: 'london-railways',
                        type: 'line',
                        source: 'london-rail',
                        filter: ['==', ['get', 'type'], 'railway'],
                        layout: {
                            'line-join': 'round',
                            'line-cap': 'round'
                        },
                        paint: {
                            'line-color': ['get', 'color'],
                            'line-width': 6,
                            'line-opacity': 0.95
                        }
                    });

                    if (me._londonHas3dRailLines && useLondonLiveTrains3d) {
                        map.setLayoutProperty('london-railways', 'visibility', 'none');
                    }

                    map.addLayer({
                        id: 'london-stations',
                        type: 'circle',
                        source: 'london-rail',
                        filter: ['==', ['get', 'type'], 'station'],
                        paint: {
                            'circle-radius': 6,
                            'circle-color': '#ffffff',
                            'circle-stroke-width': 2,
                            'circle-stroke-color': '#000000',
                            'circle-opacity': 0.98
                        }
                    });

                    // Auto-zoom to the fallback data so it's obvious when it works
                    const bounds = new LngLatBounds();
                    for (const f of londonGeo.features || []) {
                        const g = f.geometry;
                        if (!g) continue;
                        if (g.type === 'Point' && Array.isArray(g.coordinates)) {
                            bounds.extend(g.coordinates);
                        } else if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
                            for (const c of g.coordinates) bounds.extend(c);
                        }
                    }
                    if (!bounds.isEmpty()) {
                        map.fitBounds(bounds, { padding: 60, duration: 0 });
                    }
                    // Quick sanity logs (open DevTools console)
                    console.log('[London fallback] features:', (londonGeo.features || []).length);
                    console.log('[London fallback] layers added:', !!map.getLayer('london-railways'), ' / ', !!map.getLayer('london-stations'));
                    map.moveLayer('london-railways');
                    map.moveLayer('london-stations');
                }
            } catch (err) {
                console.error('[London fallback] failed to add layers/source', err);
            }

            // London live trains: Victoria line using TfL arrivals predictions.
            if (useLondonLiveTrains3d) {
                me._pendingLondonLiveTrains3d = { lineId: 'victoria', pollMs: 10000 };
            }

            me.initLondonHoverPopups();
        }

        for (const zoom of [13, 14, 15, 16, 17, 18]) {
            const interpolate = ['interpolate', ['exponential', 2], ['zoom']],
                width = ['get', 'width'],
                color = ['get', 'color'],
                lineWidth =
                    zoom === 13 ? [...interpolate, 9, ['/', width, 8], 12, width] :
                        zoom === 18 ? [...interpolate, 19, width, 22, ['*', width, 8]] :
                            width;

            for (const key of ['railways', 'stations', 'stations-outline']) {
                map.addLayer({
                    id: `${key}-og-${zoom}`,
                    type: key === 'stations' ? 'fill' : 'line',
                    source: 'odpt',
                    filter: [
                        'all',
                        ['==', ['get', 'zoom'], zoom],
                        ['==', ['get', 'type'], key === 'railways' ? 0 : 1]
                    ],
                    layout: {
                        visibility: zoom === layerZoom ? 'visible' : 'none'
                    },
                    paint: {
                        'railways': {
                            'line-color': color,
                            'line-width': lineWidth,
                            'line-emissive-strength': 1
                        },
                        'stations': {
                            'fill-color': color,
                            'fill-opacity': .7,
                            'fill-emissive-strength': 1
                        },
                        'stations-outline': {
                            'line-color': ['get', 'outlineColor'],
                            'line-width': lineWidth,
                            'line-emissive-strength': 1
                        }
                    }[key],
                    metadata: {
                        'mt3d:opacity-effect': true,
                        'mt3d:opacity': 1,
                        'mt3d:opacity-route': 0.1,
                        'mt3d:opacity-underground': 0.25,
                        'mt3d:opacity-underground-route': 0.1
                    }
                }, 'trees');
            }

        }

        if (enableTrafficLayer) {
            me.addLayer(me.trafficLayer, 'trees');
        }

        // London currently does not generate the full MT3D route/features datasets.
        // Avoid initializing the TrafficLayer route pipeline with undefined features,
        // which causes RouteData.addGroup() to crash and triggers WebGL zero-size texture errors.
        if (enableTrafficLayer) {
            const routeData = [],
                colorData = [];

            for (const { id, color } of me.railways.getAll()) {
                routeData.push({
                    id,
                    feature: [13, 14, 15, 16, 17, 18].map(zoom => me.featureLookup.get(`${id}.${zoom}`))
                });
                colorData.push({ id, color });
            }
            if (!isLondon) {
                for (const [id, feature] of me.featureLookup) {
                    if (feature && feature.properties && feature.properties.altitude > 0) {
                        routeData.push({ id, feature });
                    }
                }
                for (const { id, color } of me.trainVehicleTypes.getAll()) {
                    colorData.push({ id, color });
                }
                for (const { id, color, tailcolor } of me.operators.getAll()) {
                    colorData.push({ id, color: [color, tailcolor] });
                }
            }

            me.trafficLayer.addRouteGroup(routeData);
            me.trafficLayer.addColorGroup(colorData);
            if (isLondon && routeData.length) {
                me._londonTrafficLayerReady = true;
            }
        } else {
            console.log('[London] skipping TrafficLayer route groups (missing features dataset)');
        }

        if (useLondonLiveTrains3d && me._pendingLondonLiveTrains3d) {
            if (me.ensureLondonTrafficLayer()) {
                me.startLondonLiveTrains(me._pendingLondonLiveTrains3d);
                delete me._pendingLondonLiveTrains3d;
            } else {
                console.warn('[London live trains] TrafficLayer not ready yet');
            }
        }

        /* For development
        me.addLayer({
            id: `airway-og-`,
            type: 'geojson',
            data: helpersGeojson.featureFilter(featureCollection, p =>
                p.type === 0 && p.altitude > 0
            ),
            filled: false,
            getLineWidth: d => d.properties.width,
            getLineColor: d => helpers.colorToRGBArray(d.properties.color),
            lineWidthUnits: 'pixels',
            lineWidthScale: 1,
            opacity: .0625,
            transitions: {opacity: configs.transitionDuration},
            parameters: {depthTest: false}
        });
        */

        me.styleOpacities = helpersMapbox.getStyleOpacities(map, 'mt3d:opacity-effect');

        const datalist = helpers.createElement('datalist', { id: 'stations' }, document.body);
        const stationTitleLookup = me.stationTitleLookup = new Map();

        for (const l of [lang, 'en']) {
            for (const railway of me.railways.getAll()) {
                for (const station of railway.stations) {
                    const { title, utitle } = station,
                        stationTitle = (utitle && utitle[l]) || helpers.normalize(title[l] || title.en),
                        key = stationTitle.toUpperCase();

                    if (!stationTitleLookup.has(key)) {
                        helpers.createElement('option', { value: stationTitle }, datalist);
                        stationTitleLookup.set(key, station);
                    }
                }
            }
        }

        if (me.searchControl) {
            const control = new SearchControl({
                title: me.dict['search'],
                placeholder: me.dict['station-name'],
                list: 'stations',
                eventHandler: ({ value }) => {
                    const station = me.stationTitleLookup.get(value.toUpperCase());

                    if (station && station.coord) {
                        me.markObject();
                        me.trackObject(me.stationGroupLookup.get(station.group));
                        return true;
                    }
                }
            });

            map.addControl(control);
        }

        if (me.navigationControl) {
            const control = me.navControl = new NavigationControl();

            control._setButtonTitle = function (button) {
                const { _zoomInButton, _zoomOutButton, _compass } = this,
                    title = button === _zoomInButton ? dict['zoom-in'] :
                        button === _zoomOutButton ? dict['zoom-out'] :
                            button === _compass ? dict['compass'] : '';

                button.title = title;
                button.setAttribute('aria-label', title);
            };
            map.addControl(control);
        }

        if (me.fullscreenControl) {
            const control = new FullscreenControl({ container });

            control._updateTitle = function () {
                const button = this._fullscreenButton,
                    title = dict[this._isFullscreen() ? 'exit-fullscreen' : 'enter-fullscreen'];

                button.title = title;
                button.setAttribute('aria-label', title);
            };
            map.addControl(control);
        }

        if (me.modeControl) {
            const control = new MapboxGLButtonControl([{
                className: 'mapboxgl-ctrl-underground',
                title: dict['enter-underground'],
                eventHandler() {
                    me._setViewMode(me.viewMode === 'ground' ? 'underground' : 'ground');
                }
            }, {
                className: 'mapboxgl-ctrl-playback',
                title: dict['enter-playback'],
                eventHandler() {
                    me._setClockMode(me.clockMode === 'realtime' ? 'playback' : 'realtime');
                }
            }, {
                className: 'mapboxgl-ctrl-eco',
                title: dict['enter-eco'],
                eventHandler() {
                    me._setEcoMode(me.ecoMode === 'eco' ? 'normal' : 'eco');
                }
            }]);

            map.addControl(control);
        }

        me.layerPanel = new LayerPanel({ layers: me.plugins });
        me.aboutPanel = new AboutPanel();

        if (me.configControl) {
            map.addControl(new MapboxGLButtonControl([{
                className: 'mapboxgl-ctrl-layers',
                title: dict['select-layers'],
                eventHandler() {
                    me.layerPanel.addTo(me);
                }
            }, {
                className: 'mapboxgl-ctrl-about',
                title: dict['about'],
                eventHandler() {
                    me.aboutPanel.addTo(me);
                }
            }]));
        }

        if (me.clockControl) {
            const control = me.clockCtrl = new ClockControl({ lang, dict, clock });

            control.on('change', me.onClockChange.bind(me));
            map.addControl(control);
        }

        map.on('mousemove', e => {
            me.markObject(me.pickObject(e.point));
        });

        map.on('mouseout', () => {
            me.markObject();
        });

        map.on('click', e => {
            const object = me.pickObject(e.point);

            me.markObject(object);
            me.trackObject(object);

            // For development
            console.log(e.lngLat);
        });

        map.on('zoom', e => {
            if (!e.tracking) {
                me.updateBaseZoom();
            }

            const zoom = map.getZoom(),
                prevLayerZoom = me.layerZoom,
                layerZoom = me.layerZoom = getLayerZoom(zoom);

            if (zoom < 13) {
                const lineWidthScale = helpers.clamp(Math.pow(2, zoom - 12), .125, 1);

                for (const id of ['stations-marked-13', 'stations-selected-13', 'railways-ug-13', 'stations-ug-13', 'railways-routeug-13', 'stations-routeug-13', 'railways-routeog-13', 'stations-routeog-13']) {
                    helpersMapbox.setLayerProps(map, id, { lineWidthScale });
                }
            } else if (zoom > 19) {
                const lineWidthScale = helpers.clamp(Math.pow(2, zoom - 19), 1, 8);

                for (const id of ['stations-marked-18', 'stations-selected-18', 'railways-ug-18', 'stations-ug-18', 'railways-routeug-18', 'stations-routeug-18', 'railways-routeog-18', 'stations-routeog-18']) {
                    helpersMapbox.setLayerProps(map, id, { lineWidthScale });
                }
            }

            // Deprecated
            // me.objectUnit = Math.max(getObjectScale(zoom) * .19, .02);

            if (prevLayerZoom !== layerZoom) {
                for (const key of ['railways', 'stations', 'stations-outline']) {
                    me.setLayerVisibility(`${key}-og-${prevLayerZoom}`, 'none');
                    me.setLayerVisibility(`${key}-og-${layerZoom}`, 'visible');
                }

                for (const { id } of me.gtfs.values()) {
                    for (const key of ['busstops', 'busstops-outline']) {
                        if (prevLayerZoom >= 14) {
                            me.setLayerVisibility(`${key}-${id}-og-${prevLayerZoom}`, 'none');
                        }
                        if (layerZoom >= 14) {
                            me.setLayerVisibility(`${key}-${id}-og-${layerZoom}`, 'visible');
                        }
                    }
                }

                if (e.tracking) {
                    me.prevLayerZoom = prevLayerZoom;
                } else {
                    delete me.prevLayerZoom;
                }
            }
        });

        map.on('render', () => {
            if (me.markedObject) {
                // Popup for a 3D object needs to be updated every time
                // because the adjustment for altitude is required
                me.updatePopup();
            }
            me.updateAdTrainPopup();
        });

        for (const plugin of me.plugins.slice().reverse()) {
            plugin.addTo(me);
        }

        animation.init();

        animation.start({
            callback: () => {
                const clock = me.clock,
                    now = clock.getTime(),
                    { minDelay, refreshInterval, realtimeCheckInterval } = configs;

                if (now - me.lastTimetableRefresh >= 86400000) {
                    me.refreshTrainTimetableData();
                    me.refreshBusData(true);
                    me.lastTimetableRefresh = clock.getTime('03:00');
                }

                // Remove all trains if the page has been invisible for certain amount of time
                if (Date.now() - me.lastFrameRefresh >= configs.refreshTimeout) {
                    me.stopAll();
                }
                me.lastFrameRefresh = Date.now();

                if (Math.floor((now - minDelay) / refreshInterval) !== Math.floor(me.lastRefresh / refreshInterval)) {
                    // Hide building models when the clock speed is high as changing lights impacts performance
                    map.setLayoutProperty('building-models', 'visibility', clock.speed <= 30 ? 'visible' : 'none');

                    helpersMapbox.setSunlight(map, now);
                    if (me.searchMode === 'none' && me.clockMode === 'playback' && !me.removing) {
                        me.refreshTrains();
                        me.refreshFlights();
                        me.refreshBuses();
                        if (isStation(me.trackedObject)) {
                            me.detailPanel.updateContent();
                        }
                    }
                    me.lastRefresh = now - minDelay;
                }

                if (Math.floor((now - minDelay) / realtimeCheckInterval) !== Math.floor(me.lastRealtimeCheck / realtimeCheckInterval)) {
                    if (me.searchMode === 'none' && me.clockMode === 'realtime' && !me.removing) {
                        me.refreshRealtimeTrainData();
                        me.refreshRealtimeFlightData();
                        me.refreshRealtimeBusData();
                        if (isStation(me.trackedObject)) {
                            me.detailPanel.updateContent();
                        }
                    }
                    me.lastRealtimeCheck = now - minDelay;
                }

                if ((me.ecoMode === 'normal' && map._loaded) || Date.now() - me.lastRepaint >= 1000 / me.ecoFrameRate) {
                    let changed;

                    me.trafficLayer.setTimeOffset(clock.getTimeOffset());

                    if (me.markedObject && isVehicle(me.markedObject)) {
                        changed = me.updateObjectPosition(me.markedObject);
                        if (changed.standing !== undefined) {
                            me.updatePopup({ setHTML: true });
                        }
                    }

                    if (me.trackedObject && isVehicle(me.trackedObject)) {
                        if (me.trackedObject !== me.markedObject) {
                            changed = me.updateObjectPosition(me.trackedObject);
                        }
                        if (changed.viewMode) {
                            me._setViewMode(changed.viewMode);
                        }
                        if (!me.viewAnimationID && !map._zooming && !map._rotating && !map._pitching) {
                            const { coord, altitude, bearing } = me.trackedObject;

                            me._jumpTo({ center: coord, altitude, bearing, bearingFactor: .02 });
                            if (me.markedObject === me.trackedObject) {
                                // This need to be called right after jumpTo() to prevent jittering
                                me.updatePopup();
                            }
                        }
                    }

                    for (const train of me.adTrains) {
                        me.updateObjectPosition(train);
                    }

                    if (!isVehicle(me.trackedObject)) {
                        if (me.trackedObject) {
                            me.refreshStationOutline();
                        }
                    }

                    map.triggerRepaint();
                    me.lastRepaint = Date.now();
                }
            }
        });

        me.initialized = true;
        me.fire({ type: 'initialized' });
    }

    /**
     * Build a simple GeoJSON from loaded railways/stations for London fallback.
     * This is used when features.json (deck.gl extruded geometry) is not generated.
     */
    buildLondonRailGeoJSON() {
        const me = this;
        const fc = {
            type: 'FeatureCollection',
            features: []
        };

        if (!me.railways || !me.stations) {
            return fc;
        }

        // Add stations (points)
        for (const st of me.stations.getAll()) {
            if (!st || !Array.isArray(st.coord)) continue;
            fc.features.push({
                type: 'Feature',
                geometry: {
                    type: 'Point',
                    coordinates: st.coord
                },
                properties: {
                    type: 'station',
                    id: st.id,
                    title: (st.title && (st.title.en || st.title.ja)) || st.id,
                    color: st.railway?.color || '#ffffff'
                }
            });
        }

        const getRailwayLineCoords = (railway) => {
            const feature = me.featureLookup && me.featureLookup.get(`${railway.id}.13`);
            const geometry = feature && feature.geometry;

            if (geometry && geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
                return geometry.coordinates;
            }

            const coords = [];
            for (const st of railway.stations || []) {
                if (st && Array.isArray(st.coord)) coords.push(st.coord);
            }
            return coords;
        };

        // Add each railway as ONE continuous LineString through its stations (London fallback)
        for (const rw of me.railways.getAll()) {
            if (!rw || !Array.isArray(rw.stations) || rw.stations.length < 2) continue;

            const coords = getRailwayLineCoords(rw);
            if (coords.length < 2) continue;

            fc.features.push({
                type: 'Feature',
                geometry: {
                    type: 'LineString',
                    coordinates: coords
                },
                properties: {
                    type: 'railway',
                    id: rw.id,
                    color: rw.color || '#00a3e0'
                }
            });
        }

        return fc;
    }

    normalizeLondonStationKey(name) {
        if (!name) return '';
        return helpers.normalize(String(name))
            .replace(/Underground Station/ig, '')
            .replace(/&/g, 'and')
            .replace(/[^a-zA-Z0-9 ]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();
    }

    resolveLondonStationInfo(name, stationLookup, stationNameKeys) {
        const me = this;
        const normalized = me.normalizeLondonStationKey(name);
        if (!normalized || !stationLookup) return null;
        if (stationLookup.has(normalized)) return stationLookup.get(normalized);
        if (!stationNameKeys || stationNameKeys.size === 0) return null;

        const findByPrefix = (key) => {
            let best = null;
            let bestDelta = Infinity;
            for (const candidate of stationNameKeys) {
                if (candidate.startsWith(key) || key.startsWith(candidate)) {
                    const delta = Math.abs(candidate.length - key.length);
                    if (delta < bestDelta) {
                        bestDelta = delta;
                        best = candidate;
                    }
                }
            }
            return best ? stationLookup.get(best) : null;
        };

        let key = normalized;
        let match = findByPrefix(key);
        if (match) return match;

        // Retry by trimming trailing short tokens (handles truncations like "ST P")
        const tokens = key.split(' ');
        while (tokens.length > 1) {
            const last = tokens[tokens.length - 1];
            if (last.length > 2) break;
            tokens.pop();
            key = tokens.join(' ');
            match = findByPrefix(key);
            if (match) return match;
        }

        return null;
    }

    getLondonRailwayByLineId(lineId) {
        const me = this;
        if (!me.railways) return null;
        return me.railways.get(`tfl.${lineId}`) || me.railways.get(lineId);
    }

    getLondonStationIndexLookup(railway) {
        const me = this;
        if (!railway) return null;
        if (!me._londonStationIndexLookup) {
            me._londonStationIndexLookup = new Map();
        }
        if (!me._londonStationIndexLookup.has(railway.id)) {
            const lookup = new Map();
            railway.stations.forEach((st, index) => {
                lookup.set(st.id, index);
            });
            me._londonStationIndexLookup.set(railway.id, lookup);
        }
        return me._londonStationIndexLookup.get(railway.id);
    }

    updateLondonLiveTrafficTrains(arrivals, stationLookup, railway, stationNameKeys) {
        const me = this;
        if (!railway || !me.trafficLayer || !me.trafficLayer.addObject) return;

        const stationIndexLookup = me.getLondonStationIndexLookup(railway);
        if (!stationIndexLookup) return;

        const routeFeature = me.featureLookup && me.featureLookup.get(`${railway.id}.13`);
        const stationOffsets = routeFeature && routeFeature.properties && routeFeature.properties['station-offsets'];
        if (!Array.isArray(stationOffsets) || stationOffsets.length < 2) return;

        if (!me._londonLiveTrafficTrains) {
            me._londonLiveTrafficTrains = new Map();
        }

        const nowOffset = me.clock.getTimeOffset();
        const byTrain = new Map();
        const arr = Array.isArray(arrivals) ? arrivals : [];

        const parseBetween = (location) => {
            const match = String(location || '').match(/between\\s+(.+?)\\s+and\\s+(.+)/i);
            return match ? { from: match[1].trim(), to: match[2].trim() } : null;
        };
        const resolveStationInfo = (value) => me.resolveLondonStationInfo(value, stationLookup, stationNameKeys);

        for (const a of arr) {
            if (!a) continue;
            const vehicleId = a.vehicleId || '';
            const direction = a.direction || '';
            const dest = a.destinationName || '';
            const stationName = a.stationName || '';
            const naptanId = a.naptanId || '';
            const currentLocation = a.currentLocation || '';
            let tts = typeof a.timeToStation === 'number' ? a.timeToStation : Number(a.timeToStation);
            if (!isFinite(tts) && a.expectedArrival) {
                const expected = Date.parse(a.expectedArrival);
                if (isFinite(expected)) {
                    tts = Math.max(0, (expected - Date.now()) / 1000);
                }
            }
            if (!isFinite(tts)) continue;

            const fallbackKeyParts = [
                direction,
                dest,
                a.destinationNaptanId || '',
                a.towards || '',
                a.platformName || ''
            ].filter(Boolean);
            const fallbackKey = fallbackKeyParts.join('|') || `${stationName}|${direction}|${dest}`;
            const key = vehicleId ? `${vehicleId}|${direction}|${dest}` : `no-vehicle|${fallbackKey}`;
            if (!byTrain.has(key)) {
                byTrain.set(key, {
                    key,
                    vehicleId: vehicleId || key,
                    direction,
                    dest,
                    currentLocation,
                    arrivals: []
                });
            }
            const entry = byTrain.get(key);
            if (!entry.currentLocation && currentLocation) {
                entry.currentLocation = currentLocation;
            }
            const expectedArrival = a.expectedArrival ? Date.parse(a.expectedArrival) : NaN;
            entry.arrivals.push({
                stationName,
                naptanId,
                timeToStation: tts,
                currentLocation,
                expectedArrival
            });
        }

        const seen = new Set();
        const pendingUpdates = [];
        const preserveTrain = (train, patch = {}) => {
            if (!train) return false;
            if (typeof train._londonProgress === 'number' &&
                typeof train._londonDurationSec === 'number' &&
                typeof train._londonLastUpdate === 'number') {
                const elapsedSec = Math.max(0, (nowOffset - train._londonLastUpdate) / 1000);
                const predicted = train._londonProgress + (elapsedSec / Math.max(train._londonDurationSec, 0.1));
                train._londonProgress = Math.max(0, Math.min(0.99, predicted));
            }
            Object.assign(train, patch);
            train._londonLastUpdate = nowOffset;
            seen.add(train.id || train.key);
            return true;
        };
        for (const t of byTrain.values()) {
            let train = me._londonLiveTrafficTrains.get(t.key);
            const predictions = [];
            for (const a of t.arrivals) {
                const stationKey = a.naptanId ? String(a.naptanId).toUpperCase() : me.normalizeLondonStationKey(a.stationName);
                const stationInfo = stationLookup.get(stationKey) || resolveStationInfo(a.stationName);
                if (!stationInfo || !stationInfo.station) continue;
                const index = stationIndexLookup.get(stationInfo.station.id);
                if (index === undefined) continue;
                predictions.push({
                    station: stationInfo.station,
                    stationIndex: index,
                    timeToStation: a.timeToStation,
                    stationName: a.stationName,
                    expectedArrival: a.expectedArrival
                });
            }
            if (!predictions.length) {
                preserveTrain(train, {
                    destinationName: t.dest,
                    currentLocation: t.currentLocation
                });
                continue;
            }

            predictions.sort((a, b) => a.timeToStation - b.timeToStation);
            const predictionsByIndex = new Map();
            for (const p of predictions) {
                const existing = predictionsByIndex.get(p.stationIndex);
                if (!existing || p.timeToStation < existing.timeToStation) {
                    predictionsByIndex.set(p.stationIndex, p);
                }
            }

            let prevStation = null;
            let nextStation = null;
            let prevIndex = undefined;
            let progress = 0;
            let durationSec = null;

            // Keep using currentLocation to find prev/next stations as a hint
            const location = String(t.currentLocation || '');
            const locationLower = location.toLowerCase();
            const between = parseBetween(location);

            if (between && between.from) {
                prevStation = resolveStationInfo(between.from)?.station || null;
                if (between.to) {
                    nextStation = resolveStationInfo(between.to)?.station || null;
                }
            } else if (locationLower.startsWith('approaching ')) {
                const name = location.replace(/approaching\\s+/i, '').replace(/\\s+platform.*$/i, '');
                nextStation = resolveStationInfo(name)?.station || null;
            } else if (locationLower.startsWith('left ')) {
                const name = location.replace(/left\\s+/i, '').replace(/\\s+platform.*$/i, '');
                prevStation = resolveStationInfo(name)?.station || null;
            } else if (locationLower.startsWith('leaving ')) {
                const name = location.replace(/leaving\\s+/i, '').replace(/\\s+platform.*$/i, '');
                prevStation = resolveStationInfo(name)?.station || null;
            } else if (locationLower.startsWith('departed ')) {
                const name = location.replace(/departed\\s+from\\s+/i, '').replace(/departed\\s+/i, '').replace(/\\s+platform.*$/i, '');
                prevStation = resolveStationInfo(name)?.station || null;
            } else if (locationLower.startsWith('at ')) {
                const name = location.replace(/at\\s+/i, '').replace(/\\s+platform.*$/i, '');
                prevStation = resolveStationInfo(name)?.station || null;
            }

            if (prevStation) {
                prevIndex = stationIndexLookup.get(prevStation.id);
            }

            const nextIndexHint = nextStation ? stationIndexLookup.get(nextStation.id) : undefined;
            let next = null;
            if (nextIndexHint !== undefined) {
                next = predictionsByIndex.get(nextIndexHint) || null;
            }
            if (!next && prevIndex !== undefined) {
                next = predictions.find(p => p.stationIndex !== prevIndex) || null;
            }
            if (!next) {
                next = predictions[0];
            }
            if (!next) {
                preserveTrain(train, {
                    destinationName: t.dest,
                    currentLocation: t.currentLocation
                });
                continue;
            }
            const nextIndex = next.stationIndex;

            let following = null;
            for (const p of predictions) {
                if (p.stationIndex !== nextIndex && p.timeToStation >= next.timeToStation) {
                    following = p;
                    break;
                }
            }

            let directionStep = 0;
            if (following && stationOffsets[nextIndex] !== undefined &&
                stationOffsets[following.stationIndex] !== undefined) {
                directionStep = stationOffsets[following.stationIndex] > stationOffsets[nextIndex] ? 1 : -1;
            } else if (t.direction === 'outbound') {
                directionStep = 1;
            } else if (t.direction === 'inbound') {
                directionStep = -1;
            } else if (train && typeof train.sectionLength === 'number') {
                directionStep = train.sectionLength > 0 ? 1 : train.sectionLength < 0 ? -1 : 0;
            }

            if (prevIndex === undefined && directionStep) {
                prevIndex = nextIndex - directionStep;
                if (prevIndex < 0 || prevIndex >= railway.stations.length) {
                    prevIndex = undefined;
                } else {
                    prevStation = railway.stations[prevIndex];
                }
            }

            if (prevIndex === undefined && train && typeof train.sectionIndex === 'number') {
                prevIndex = train.sectionIndex;
                prevStation = railway.stations[prevIndex];
            }

            if (prevIndex === undefined || prevIndex === nextIndex) {
                preserveTrain(train, {
                    destinationName: t.dest,
                    timeToStation: next.timeToStation,
                    currentLocation: t.currentLocation
                });
                continue;
            }
            if (prevIndex < 0 || nextIndex < 0 || prevIndex >= stationOffsets.length || nextIndex >= stationOffsets.length) {
                preserveTrain(train, {
                    destinationName: t.dest,
                    timeToStation: next.timeToStation,
                    currentLocation: t.currentLocation
                });
                continue;
            }

            const sectionLength = nextIndex - prevIndex;
            let segmentLength = null;

            if (stationOffsets && stationOffsets.length > Math.max(prevIndex, nextIndex)) {
                const offsetPrev = stationOffsets[prevIndex];
                const offsetNext = stationOffsets[nextIndex];

                if (isFinite(offsetPrev) && isFinite(offsetNext)) {
                    segmentLength = Math.abs(offsetNext - offsetPrev);
                    if (segmentLength > 0) {
                        // Time-based duration calculation
                        if (following && following.timeToStation > next.timeToStation &&
                            stationOffsets[following.stationIndex] !== undefined) {
                            // Calculate speed from the next segment (next -> following)
                            const offsetFollowing = stationOffsets[following.stationIndex];
                            const timeForNextSegment = Math.max(1, following.timeToStation - next.timeToStation);
                            const distanceOfNextSegment = Math.abs(offsetFollowing - offsetNext);
                            const speed = distanceOfNextSegment / timeForNextSegment;

                            // Apply that speed to the current segment
                            durationSec = segmentLength / Math.max(0.0015, Math.min(0.03, speed));
                        } else {
                            // Fallback to default speed
                            durationSec = segmentLength / LONDON_DEFAULT_SEGMENT_SPEED_KM_PER_SEC;
                        }
                    }
                }
            }

            if (!durationSec) {
                // If we couldn't calculate duration from distance, estimate it.
                // Fallback to a simple time-based estimation. Assume the train is
                // halfway through the segment, so the total segment duration is
                // double the time remaining.
                durationSec = next.timeToStation * 2;
            }

            // Ensure duration is valid and at least covers the time to the next station
            if (isFinite(durationSec)) {
                durationSec = Math.max(durationSec, Math.max(15, next.timeToStation * 1.05));
            } else {
                continue; // Cannot proceed without a valid duration
            }

            // This is the new time-based progress calculation
            const safeTimeToStation = Math.max(0.1, next.timeToStation);
            progress = 1 - (safeTimeToStation / durationSec);

            // Clamp progress to a valid range
            if (!isFinite(progress)) {
                continue;
            }
            progress = Math.max(0, Math.min(0.99, progress));

            // Keep the smoothing logic from the original implementation
            if (train && train.sectionIndex === prevIndex && train.sectionLength === sectionLength &&
                typeof train._londonProgress === 'number') {
                let predictedProgress = train._londonProgress;
                if (typeof train._londonDurationSec === 'number' && typeof train._londonLastUpdate === 'number') {
                    const elapsedSec = Math.max(0, (nowOffset - train._londonLastUpdate) / 1000);
                    predictedProgress = train._londonProgress + (elapsedSec / Math.max(train._londonDurationSec, 0.1));
                }
                // Avoid snapping backwards; limit large forward jumps too
                if (predictedProgress > progress) {
                    progress = Math.min(0.99, predictedProgress);
                } else if (progress - predictedProgress > 0.2) {
                    progress = Math.min(0.99, predictedProgress + 0.2);
                }
            }

            const duration = durationSec * 1000;
            const nowEpoch = me.clock.getTime();
            const nextEpoch = isFinite(next.expectedArrival) ? next.expectedArrival : nowEpoch + next.timeToStation * 1000;
            const prevEpoch = isFinite(nextEpoch) ? nextEpoch - duration : NaN;
            const accelTime = duration / 2;
            const accel = 4 / (duration * duration);

            if (!train) {
                train = {
                    type: 'train',
                    id: t.key,
                    n: t.vehicleId || t.key,
                    r: railway,
                    d: railway.ascending,
                    liveTfL: true
                };
                me._londonLiveTrafficTrains.set(t.key, train);
            }
            train._londonProgress = progress;
            train._londonDurationSec = durationSec;
            train._londonLastUpdate = nowOffset;

            train.sectionIndex = prevIndex;
            train.sectionLength = sectionLength;
            train.departureStation = prevStation;
            train.arrivalStation = next.station;
            train.destinationName = t.dest;
            train.timeToStation = next.timeToStation;
            train.currentLocation = t.currentLocation;
            train._tflPrevTime = isFinite(prevEpoch) ? prevEpoch : undefined;
            train._tflNextTime = isFinite(nextEpoch) ? nextEpoch : undefined;
            train.d = sectionLength >= 0 ? railway.descending : railway.ascending;

            if (train.instanceID === undefined) {
                me.trafficLayer.addObject(train);
            }
            pendingUpdates.push({
                train,
                progress,
                duration,
                accelTime,
                accel,
                sectionKey: `${railway.id}|${prevIndex}|${nextIndex}`,
                timeToStation: next.timeToStation
            });
            seen.add(t.key);
        }

        // De-overlap trains on the same segment by spacing their progress slightly.
        if (pendingUpdates.length > 1) {
            const groups = new Map();
            for (const update of pendingUpdates) {
                const key = update.sectionKey;
                const list = groups.get(key);
                if (list) {
                    list.push(update);
                } else {
                    groups.set(key, [update]);
                }
            }
            for (const list of groups.values()) {
                if (list.length < 2) continue;
                list.sort((a, b) => a.timeToStation - b.timeToStation);
                for (let i = 0; i < list.length; i++) {
                    const adjusted = Math.max(0, Math.min(0.99, list[i].progress - i * LONDON_OVERLAP_PROGRESS_SPACING));
                    list[i].progress = adjusted;
                }
            }
        }

        for (const update of pendingUpdates) {
            const { train, progress, duration, accelTime, accel } = update;
            const startTime = nowOffset - progress * duration;
            train._londonProgress = progress;
            me.trafficLayer.updateObject(train, startTime, duration, accelTime, accel, accelTime, accel);
        }

        for (const [key, train] of me._londonLiveTrafficTrains.entries()) {
            if (!seen.has(key)) {
                const lastUpdate = train._londonLastUpdate;
                if (typeof lastUpdate === 'number' && nowOffset - lastUpdate < 30000) {
                    continue;
                }
                me.trafficLayer.removeObject(train);
                me._londonLiveTrafficTrains.delete(key);
            }
        }
    }

    initLondonHoverPopups() {
        const me = this;

        if (!me.map) {
            return;
        }

        const map = me.map;

        if (!me._londonStationHoverPopup) {
            me._londonStationHoverPopup = new AnimatedPopup({
                className: 'popup-object',
                closeButton: false,
                closeOnClick: false,
                maxWidth: '260px',
                offset: {
                    top: [0, 10],
                    bottom: [0, -20]
                },
                openingAnimation: {
                    duration: 150,
                    easing: 'easeOutBack'
                }
            });
        }
        const stationPopup = me._londonStationHoverPopup;

        const hidePopup = (popup) => {
            if (popup && popup.isOpen()) popup.remove();
        };

        const showPopup = (popup, lngLat, html) => {
            popup.setLngLat(lngLat).setHTML(html).addTo(map);
        };

        if (map.getLayer('london-stations') && !me._londonHoverStationsBound) {
            map.on('mousemove', 'london-stations', (e) => {
                const feature = e.features && e.features[0];
                if (!feature) return;
                const title = feature.properties && (feature.properties.title || feature.properties.id) || 'Station';
                showPopup(stationPopup, e.lngLat, title);
                map.getCanvas().style.cursor = 'pointer';
            });
            map.on('mouseleave', 'london-stations', () => {
                hidePopup(stationPopup);
                map.getCanvas().style.cursor = '';
            });
            me._londonHoverStationsBound = true;
        }

        // 2D train hover popups removed (London uses 3D trains only).
    }

    ensureLondonTrafficLayer() {
        const me = this;

        if (!me.featureLookup || !me.railways) {
            console.warn('[London] missing features for TrafficLayer');
            return false;
        }

        if (!me.trafficLayer || me.trafficLayer.type !== 'three') {
            me.trafficLayer = new TrafficLayer({ id: 'traffic' });
            me.addLayer(me.trafficLayer, 'trees');
        }

        if (!me.trafficLayer.computeRenderer) {
            console.warn('[London] TrafficLayer not ready yet');
            return false;
        }

        if (me._londonTrafficLayerReady) {
            return true;
        }

        const routeData = [];
        const colorData = [];

        for (const { id, color } of me.railways.getAll()) {
            const features = [13, 14, 15, 16, 17, 18].map(zoom => me.featureLookup.get(`${id}.${zoom}`));
            if (features.some(f => !f)) {
                console.warn('[London] missing route features for', id);
                continue;
            }
            routeData.push({ id, feature: features });
            colorData.push({ id, color });
        }

        if (!routeData.length) {
            console.warn('[London] no route data for TrafficLayer');
            return false;
        }

        me.trafficLayer.addRouteGroup(routeData);
        me.trafficLayer.addColorGroup(colorData);
        me._londonTrafficLayerReady = true;
        return true;
    }

    clearLondonLiveTrafficTrains() {
        const me = this;
        if (!me._londonLiveTrafficTrains || !me.trafficLayer || !me.trafficLayer.removeObject) {
            me._londonLiveTrafficTrains = new Map();
            return;
        }

        for (const train of me._londonLiveTrafficTrains.values()) {
            me.trafficLayer.removeObject(train);
        }
        me._londonLiveTrafficTrains.clear();
    }

    /**
     * London live trains (Path B MVP).
     * Uses TfL `/Line/{lineId}/Arrivals` predictions to render moving dots.
     * Note: Not true GPS positions; we place the dot at the next predicted station.
     */
    startLondonLiveTrains({ lineId = 'victoria', pollMs = 10000 } = {}) {
        const me = this;

        if (me._londonLiveTrainsTimer) {
            clearInterval(me._londonLiveTrainsTimer);
            me._londonLiveTrainsTimer = null;
        }

        if (!me.map) {
            console.warn('[London live trains] missing map instance');
            return;
        }
        if (!me.ensureLondonTrafficLayer()) {
            if (!me._londonLiveTrainsRetry && me.map) {
                me._londonLiveTrainsRetry = true;
                me.map.once('idle', () => {
                    me._londonLiveTrainsRetry = false;
                    me.startLondonLiveTrains({ lineId, pollMs });
                });
            }
            return;
        }

        // Build a lookup from station name/naptanId -> { station, lng, lat, color }.
        const stationLookup = new Map();
        const stationNameKeys = new Set();
        if (me.stations) {
            for (const st of me.stations.getAll()) {
                if (!st || !st.coord || !st.title) continue;
                const name = (st.title.en || st.title.ja || '').trim();
                if (!name) continue;
                const norm = me.normalizeLondonStationKey(name);
                const normShort = me.normalizeLondonStationKey(name.replace(/ Underground Station$/i, ''));
                const info = {
                    station: st,
                    lng: st.coord[0],
                    lat: st.coord[1],
                    color: st.railway?.color
                };
                stationLookup.set(norm, info);
                if (norm) stationNameKeys.add(norm);
                if (normShort) {
                    stationLookup.set(normShort, info);
                    stationNameKeys.add(normShort);
                }
                if (st.id) {
                    const naptan = String(st.id).split('.').pop();
                    if (naptan) {
                        stationLookup.set(naptan.toUpperCase(), info);
                    }
                }
            }
        }

        const tick = async () => {
            try {
                const arrivals = await me.fetchTfLJson(`/Line/${encodeURIComponent(lineId)}/Arrivals`);
                const railway = me.getLondonRailwayByLineId(lineId);
                me.updateLondonLiveTrafficTrains(arrivals, stationLookup, railway, stationNameKeys);
            } catch (e) {
                // Common causes: missing/invalid app key, network/CORS, TfL rate limit
                console.warn('[London live trains] poll failed:', e);
            }
        };

        // Prime immediately, then poll.
        tick();
        me._londonLiveTrainsTimer = setInterval(tick, pollMs);
        console.log(`[London live trains] polling TfL line=${lineId} every ${pollMs}ms`);
    }

    fetchTfLJson(path) {
        const me = this;

        const base = 'https://api.tfl.gov.uk';
        const url = new URL(base + path);

        // Support either Vite env var or secrets injected into options
        const envKey = (typeof import.meta !== 'undefined' && import.meta.env && (import.meta.env.VITE_TFL_APP_KEY || import.meta.env.VITE_TFL_KEY))
            ? (import.meta.env.VITE_TFL_APP_KEY || import.meta.env.VITE_TFL_KEY)
            : null;
        const secretKey = me.secrets && (me.secrets.tflAppKey || me.secrets.tfl_key || me.secrets.tflKey);
        const appKey = envKey || secretKey;

        if (appKey) {
            url.searchParams.set('app_key', appKey);
        } else if (!me._tflKeyWarned) {
            me._tflKeyWarned = true;
            console.warn('[London live trains] missing TfL app key (set MT3D_CONFIG.secrets.tflAppKey)');
        }

        return fetch(url.toString()).then(async res => {
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                throw new Error(`TfL ${res.status} ${text}`);
            }
            return res.json();
        });
    }


    _jumpTo(options) {
        const me = this,
            { map, trackingMode, trackingParams } = me,
            frameRateFactor = me.ecoMode === 'normal' || me.viewAnimationID ? me.frameRateFactor : 60 / me.ecoFrameRate,
            now = performance.now(),
            currentZoom = map.getZoom(),
            currentBearing = map.getBearing(),
            currentPitch = map.getPitch(),
            scrollZooming = map.scrollZoom._active;
        let zoom, pitch,
            { center, altitude, bearing, easeOutFactor, easeInFactor, bearingFactor } = options;

        if (trackingMode === 'position') {
            zoom = me.baseZoom;
            bearing = currentBearing;
            pitch = currentPitch;
        } else if (trackingMode === 'helicopter') {
            zoom = 15;
            bearing = trackingParams.bearing.fn(now);
            pitch = 60;
        } else if (trackingMode === 'drone') {
            zoom = 17;
            bearing = trackingParams.bearing.fn(now);
            pitch = 75;
        } else if (trackingMode === 'bird') {
            me.updateTrackingParams();
            zoom = trackingParams.zoom.fn(now);
            bearing = trackingParams.bearing.fn(now);
            pitch = trackingParams.pitch.fn(now);
        } else {
            if (trackingMode === 'front' || trackingMode === 'topfront') {
                bearing = (bearing + 360) % 360 - 180;
            }
            if (bearingFactor >= 0) {
                bearingFactor = 1 - Math.pow(1 - bearingFactor, frameRateFactor);
                bearing = currentBearing + ((bearing - currentBearing + 540) % 360 - 180) * bearingFactor;
            }
            if (trackingMode === 'back' || trackingMode === 'front') {
                zoom = 18.5;
                pitch = 85;
            } else {
                zoom = 15;
                pitch = 60;
            }
        }

        const cameraToGround = map.getFreeCameraOptions().position.z / Math.cos(currentPitch * DEGREE_TO_RADIAN),
            cameraToObject = cameraToGround * Math.pow(2, currentZoom - zoom),
            objectToGround = me.getModelPosition(center, altitude).z / Math.cos(pitch * DEGREE_TO_RADIAN);

        // Adjust zoom according to the altitude of the object
        zoom = Math.min(zoom - Math.log2(Math.max(cameraToObject + objectToGround, 0) / cameraToObject), 22);

        center = me.adjustCoord(center, altitude, bearing);
        if (easeOutFactor >= 0) {
            const currentCenter = map.getCenter();

            easeOutFactor = 1 - Math.pow(1 - easeOutFactor, frameRateFactor);
            center = new LngLat(
                helpers.lerp(currentCenter.lng, center.lng, easeOutFactor),
                helpers.lerp(currentCenter.lat, center.lat, easeOutFactor)
            );
        }
        if (easeInFactor >= 0) {
            easeInFactor = 1 - Math.pow(1 - easeInFactor, frameRateFactor);
            zoom = helpers.lerp(currentZoom, zoom, easeInFactor);
            pitch = helpers.lerp(currentPitch, pitch, easeInFactor);
        }

        // Prevent layer switch due to calculation error
        if (Math.floor(zoom + 1) - zoom < 1e-6) {
            zoom = Math.floor(zoom + 1);
        }

        // Prevent layer switch back and forth
        if (me.prevLayerZoom === getLayerZoom(zoom)) {
            zoom = currentZoom;
        } else {
            delete me.prevLayerZoom;
        }

        map.jumpTo({ center, zoom, bearing, pitch }, { tracking: true });

        // Workaround for the issue of the scroll zoom during tracking
        if (scrollZooming) {
            map.scrollZoom._active = true;
        }
    }

    refreshTrains() {
        const me = this,
            initialSelection = me.initialSelection,
            now = me.clock.getTimeOffset();

        if (me.useLondonLiveTrains && me.getCityFromLocation() === 'london') {
            return;
        }

        for (const timetable of me.timetables.getAll()) {
            if (timetable.start <= now && now <= timetable.end && !me.standbyTrainLookup.has(timetable.id)) {
                me.trainStart(new Train(timetable));
            }
        }

        me.trafficLayer.refreshDelayMarkers();

        me.trainLoaded = true;
        if (initialSelection) {
            me.setSelection(initialSelection);
        }
    }

    trainStart(train, options = {}) {
        const me = this,
            railway = train.r;

        if (me.checkActiveTrains(train) || (railway.status && railway.dynamic && !me.realtimeTrains.has(train.id)) || railway.suspended) {
            return;
        }
        if (!me.setSectionData(train, options.index)) {
            return; // Out of range
        }

        me.activeTrainLookup.set(train.id, train);
        me.trafficLayer.addObject(train);
        me.trainRepeat(train, options.index);

        if (options.marked) {
            me.markObject(train);
        }
        if (options.tracked) {
            me.trackObject(train);
        }
        if (train.ad) {
            me.showAdTrainPopup(train);
        }
    }

    trainRepeat(train, index) {
        const me = this,
            { activeTrainLookup, clock } = me,
            timetable = train.timetable,
            now = clock.getTimeOffset(),
            minStandingDuration = configs.minStandingDuration;
        let final;

        if (timetable) {
            final = !me.setSectionData(train, index);
            if (final) {
                const nextTimetables = timetable.nt;

                if (nextTimetables) {
                    let needToStand = false;

                    for (const { t: id } of nextTimetables[0].pt) {
                        const prevTrain = activeTrainLookup.get(id);

                        if (prevTrain && prevTrain.arrivalStation) {
                            needToStand = true;
                        }
                    }
                    if (!needToStand) {
                        let marked = false,
                            tracked = false;

                        for (const { t: id } of nextTimetables[0].pt) {
                            const prevTrain = activeTrainLookup.get(id);

                            if (prevTrain) {
                                if (me.markedObject === prevTrain) {
                                    marked = true;
                                }
                                if (me.trackedObject === prevTrain) {
                                    tracked = true;
                                }
                                me.stopTrain(prevTrain);
                            }
                        }
                        nextTimetables.forEach((nextTimetable, i) => {
                            const nextTrain = me.standbyTrainLookup.get(nextTimetable.id) || new Train(nextTimetable);

                            me.trainStart(nextTrain, i === 0 ? { index: 0, marked, tracked } : { index: 0 });
                        });
                    }
                    return;
                }
            }
        } else {
            final = !me.setSectionData(train, undefined, !me.realtimeTrains.has(train.id));
        }

        if (me.markedObject === train) {
            train.standing = true;
            me.updatePopup({ setHTML: true });
        }

        const sectionLength = train.sectionLength;

        if (!final && sectionLength !== 0) {
            const delay = train.delay || 0,
                minDelay = configs.minDelay,
                { departureTime, arrivalTime, nextDepartureTime, sectionIndex } = train,
                feature = me.featureLookup.get(`${train.r.id}.18`),
                stationOffsets = feature.properties['station-offsets'],
                distance = Math.abs(stationOffsets[sectionIndex + sectionLength] - stationOffsets[sectionIndex]),
                actualDepartureTime = index !== undefined ? Math.max(departureTime + delay, now + (clock.speed === 1 ? minStandingDuration : 0)) : departureTime !== undefined ? departureTime + delay : now;
            let { maxSpeed, acceleration, maxAccelerationTime, maxAccDistance } = configs,
                duration, minDuration, maxDuration, accelerationTime;

            if (nextDepartureTime !== undefined) {
                maxDuration = nextDepartureTime - minStandingDuration + 60000 + delay - minDelay - actualDepartureTime;
            }
            if (arrivalTime !== undefined) {
                minDuration = arrivalTime + delay - minDelay - actualDepartureTime;
                if (!(maxDuration < minDuration + 60000)) {
                    maxDuration = minDuration + 60000;
                }
            }

            if (distance <= maxAccDistance * 2) {
                duration = Math.sqrt(distance / acceleration) * 2;
                if (maxDuration > 0) {
                    duration = helpers.clamp(duration, minDuration || 0, maxDuration);
                    acceleration = distance * 4 / duration / duration;
                }
                accelerationTime = duration / 2;
            } else {
                duration = maxAccelerationTime * 2 + (distance - maxAccDistance * 2) / maxSpeed;
                if (maxDuration > 0) {
                    duration = helpers.clamp(duration, minDuration || 0, maxDuration);
                    maxAccDistance = acceleration * duration * duration / 8;
                    if (distance >= maxAccDistance * 2) {
                        maxSpeed = distance * 2 / duration;
                        acceleration = maxSpeed * 2 / duration;
                    } else {
                        maxSpeed = acceleration * duration / 2 - Math.sqrt(acceleration * (maxAccDistance * 2 - distance));
                    }
                }
                accelerationTime = maxSpeed / acceleration;
            }
            me.trafficLayer.updateObject(train, actualDepartureTime, duration, accelerationTime, acceleration / distance, accelerationTime, acceleration / distance);

            train.animationID = animation.start({
                complete: () => {
                    me.trainRepeat(train, timetable ? train.timetableIndex + 1 : undefined);
                },
                duration: actualDepartureTime + duration - now,
                clock
            });
        } else {
            train.animationID = animation.start({
                complete: () => {
                    if (final) {
                        me.stopTrain(train);
                    } else {
                        me.trainRepeat(train);
                    }
                },
                duration: timetable ?
                    Math.max(train.departureTime - now, minStandingDuration) :
                    final ? minStandingDuration : configs.realtimeCheckInterval,
                clock
            });
        }
    }

    refreshFlights() {
        const me = this,
            initialSelection = me.initialSelection,
            now = me.clock.getTimeOffset();

        for (const flight of me.flightLookup.values()) {
            if (flight.entry <= now && now <= flight.end) {
                me.flightStart(flight);
            }
        }

        me.flightLoaded = true;
        if (initialSelection) {
            me.setSelection(initialSelection);
        }
    }

    flightStart(flight) {
        const me = this,
            { activeFlightLookup, clock } = me,
            id = flight.id;

        if (activeFlightLookup.has(id)) {
            return;
        }

        activeFlightLookup.set(id, flight);
        me.trafficLayer.addObject(flight);

        const now = clock.getTimeOffset(),
            distance = flight.feature.properties.length,
            maxSpeed = flight.maxSpeed,
            acceleration = flight.acceleration > 0 ? flight.acceleration : 0,
            deceleration = flight.acceleration > 0 ? 0 : -flight.acceleration,
            accelerationTime = acceleration > 0 ? maxSpeed / acceleration : 0,
            decelerationTime = deceleration > 0 ? maxSpeed / deceleration : 0,
            duration = accelerationTime / 2 + distance / maxSpeed + decelerationTime / 2;

        me.trafficLayer.updateObject(flight, flight.start, duration, accelerationTime, acceleration / distance, decelerationTime, deceleration / distance);

        flight.animationID = animation.start({
            complete: () => {
                me.stopFlight(flight);
            },
            duration: flight.end - now,
            clock
        });
    }

    refreshBuses(gtfsId) {
        const me = this,
            now = me.clock.getTimeOffset();

        for (const gtfs of gtfsId ? [me.gtfs.get(gtfsId)] : me.gtfs.values()) {
            for (const trip of gtfs.tripLookup.values()) {
                const departureTimes = trip.departureTimes,
                    route = gtfs.routeLookup.get(trip.route);

                if (departureTimes[0] <= now && now <= departureTimes[departureTimes.length - 1] && !gtfs.activeBusLookup.has(trip.id) && route && !route.hidden) {
                    let offset = 0;
                    const feature = gtfs.featureLookup.get(trip.shape);

                    if (!feature) {
                        continue;
                    }

                    const offsets = trip.stops.map(stopId =>
                        // Use the previous offset to calulate a weight and pick a closer point
                        (offset = nearestCloserPointOnLine(feature, gtfs.stopLookup.get(stopId).coord, offset).properties.location)
                    );

                    me.busStart({
                        type: 'bus',
                        gtfsId: gtfs.id,
                        trip,
                        feature,
                        offsets,
                        offset: 0
                    });
                }
            }
        }
    }

    busStart(bus) {
        const me = this;

        if (!me.setBusSectionData(bus)) {
            return;
        }
        me.gtfs.get(bus.gtfsId).activeBusLookup.set(bus.trip.id, bus);
        me.trafficLayer.addObject(bus);
        me.busRepeat(bus);
    }

    busRepeat(bus, index) {
        const me = this,
            clock = me.clock,
            now = clock.getTimeOffset(),
            minBusStandingDuration = configs.minBusStandingDuration;
        let final;

        if (bus.stop === undefined) {
            final = !me.setBusSectionData(bus, index);
        } else {
            final = !me.setBusSectionData(bus, undefined, !me.gtfs.get(bus.gtfsId).realtimeBuses.has(bus.trip.id));
        }

        if (me.markedObject === bus) {
            me.updatePopup({ setHTML: true });
        }
        if (me.trackedObject === bus && me.detailPanel) {
            me.detailPanel.updateHeader();
        }

        const { offsets, sectionIndex, sectionLength } = bus,
            distance = Math.abs(offsets[sectionIndex + sectionLength] - offsets[sectionIndex]);

        // Sometimes distance becomes 0 because the busroute coordinates
        // are incorrect and a few busstops shares the same coordinates.
        if (!final && sectionLength > 0 && distance === 0) {
            console.log('bus zero interval:', bus);
        }

        if (!final && sectionLength > 0 && distance > 0) {
            const minDelay = configs.minDelay,
                { departureTime, nextDepartureTime } = bus,
                actualDepartureTime = index !== undefined ? Math.max(departureTime, now + (clock.speed === 1 ? minBusStandingDuration : 0)) : helpers.valueOrDefault(departureTime, now);
            let { maxBusSpeed, busAcceleration, maxBusAccelerationTime, maxBusAccDistance } = configs,
                duration, maxDuration, accelerationTime;

            if (nextDepartureTime !== undefined) {
                maxDuration = nextDepartureTime - minBusStandingDuration + 60000 - minDelay - actualDepartureTime;
            }

            if (distance <= maxBusAccDistance * 2) {
                duration = Math.sqrt(distance / busAcceleration) * 2;
                if (maxDuration > 0) {
                    duration = helpers.clamp(duration, 0, maxDuration);
                    busAcceleration = distance * 4 / duration / duration;
                }
                accelerationTime = duration / 2;
            } else {
                duration = maxBusAccelerationTime * 2 + (distance - maxBusAccDistance * 2) / maxBusSpeed;
                if (maxDuration > 0) {
                    duration = helpers.clamp(duration, 0, maxDuration);
                    maxBusAccDistance = busAcceleration * duration * duration / 8;
                    if (distance >= maxBusAccDistance * 2) {
                        maxBusSpeed = distance * 2 / duration;
                        busAcceleration = maxBusSpeed * 2 / duration;
                    } else {
                        maxBusSpeed = busAcceleration * duration / 2 - Math.sqrt(busAcceleration * (maxBusAccDistance * 2 - distance));
                    }
                }
                accelerationTime = maxBusSpeed / busAcceleration;
            }
            me.trafficLayer.updateObject(bus, actualDepartureTime, duration, accelerationTime, busAcceleration / distance, accelerationTime, busAcceleration / distance);

            bus.animationID = animation.start({
                complete: () => {
                    me.busRepeat(bus, bus.stop === undefined ? bus.sectionIndex + 1 : undefined);
                },
                duration: actualDepartureTime + duration - now,
                clock
            });
        } else {
            bus.animationID = animation.start({
                complete: () => {
                    if (final) {
                        me.stopBus(bus);
                    } else {
                        me.busRepeat(bus);
                    }
                },
                duration: bus.stop === undefined ?
                    Math.max(bus.nextDepartureTime - now, minBusStandingDuration) :
                    final ? minBusStandingDuration : configs.realtimeCheckInterval,
                clock
            });
        }
    }

    updateTrackingParams(reset) {
        const me = this,
            { map, trackingMode, trackingParams } = me,
            now = performance.now();

        if (trackingMode === 'bird') {
            const { zoom, bearing, pitch } = trackingParams;

            if (!zoom.time || reset) {
                const time = zoom.time = [0, now, 0, 0],
                    value = zoom.value = [0, me.baseZoom, 0, 0];
                for (const [i, j] of [[0, 1], [2, 1], [3, 2]]) {
                    time[i] = time[j] + Math.sign(i - j) * (Math.random() * 10000 + 30000);
                    value[i] = Math.random() * 5 + 15;
                }
                zoom.fn = createInterpolant(time, value);
            } else if (now >= zoom.time[2]) {
                zoom.time = zoom.time.slice(1).concat(zoom.time[3] + Math.random() * 10000 + 30000);
                zoom.value = zoom.value.slice(1).concat(Math.random() * 5 + 15);
                zoom.fn = createInterpolant(zoom.time, zoom.value);
            }
            if (!bearing.time || reset) {
                const time = bearing.time = [0, now, 0, 0],
                    value = bearing.value = [0, map.getBearing(), 0, 0];
                for (const [i, j] of [[0, 1], [2, 1], [3, 2]]) {
                    time[i] = time[j] + Math.sign(i - j) * (Math.random() * 10000 + 40000);
                    value[i] = Math.random() * 360 - 180;
                }
                bearing.fn = createInterpolant(time, value);
            } else if (now >= bearing.time[2]) {
                bearing.time = bearing.time.slice(1).concat(bearing.time[3] + Math.random() * 10000 + 40000);
                bearing.value = bearing.value.slice(1).concat(Math.random() * 360 - 180);
                bearing.fn = createInterpolant(bearing.time, bearing.value);
            }
            if (!pitch.time || reset) {
                const time = pitch.time = [0, now, 0, 0],
                    value = pitch.value = [0, map.getPitch(), 0, 0];
                for (const [i, j] of [[0, 1], [2, 1], [3, 2]]) {
                    time[i] = time[j] + Math.sign(i - j) * (Math.random() * 10000 + 20000);
                    value[i] = Math.random() * 30 + 45;
                }
                pitch.fn = createInterpolant(time, value);
            } else if (now >= pitch.time[2]) {
                pitch.time = pitch.time.slice(1).concat(pitch.time[3] + Math.random() * 10000 + 20000);
                pitch.value = pitch.value.slice(1).concat(Math.random() * 30 + 45);
                pitch.fn = createInterpolant(pitch.time, pitch.value);
            }
        } else {
            delete trackingParams.zoom.time;
            delete trackingParams.bearing.time;
            delete trackingParams.pitch.time;
            if (trackingMode === 'drone') {
                const bearing = map.getBearing();
                trackingParams.bearing.fn = t => (bearing - (t - now) / 200) % 360;
            } else if (trackingMode === 'helicopter') {
                const bearing = map.getBearing();
                trackingParams.bearing.fn = t => (bearing + (t - now) / 400) % 360;
            }
        }
    }

    updateHandlersAndControls() {
        const me = this,
            { map, trackedObject, trackingMode } = me,
            handlers = ['scrollZoom', 'boxZoom', 'dragRotate', 'dragPan', 'keyboard', 'doubleClickZoom', 'touchZoomRotate', 'touchPitch'];

        if (isVehicle(trackedObject) && trackingMode !== 'position') {
            for (const handler of handlers) {
                map[handler].disable();
            }
            me.navControl.disable();
        } else {
            for (const handler of handlers) {
                map[handler].enable();
            }
            if (isVehicle(trackedObject) && trackingMode === 'position') {
                map.dragPan.disable();
            }
            me.navControl.enable();
        }
    }

    startViewAnimation() {
        const me = this;
        let t2 = 0,
            t4 = 0;

        me.viewAnimationID = animation.start({
            callback: (elapsed, duration) => {
                const trackedObject = me.trackedObject,
                    t1 = easeOutQuart(elapsed / duration),
                    easeOutFactor = 1 - (1 - t1) / (1 - t2),
                    t3 = easeInQuad(elapsed / duration),
                    easeInFactor = 1 - (1 - t3) / (1 - t4);

                me._jumpTo({
                    center: trackedObject.coord,
                    altitude: trackedObject.altitude,
                    bearing: trackedObject.bearing,
                    easeOutFactor,
                    easeInFactor,
                    bearingFactor: easeOutFactor
                });
                t2 = t1;
                t4 = t3;
            },
            complete: () => {
                delete me.viewAnimationID;
            },
            duration: 1000
        });
    }

    stopViewAnimation() {
        const me = this;

        if (me.viewAnimationID) {
            animation.stop(me.viewAnimationID);
            delete me.viewAnimationID;
        }
    }

    /**
     * Returns a LngLat representing geographical coordinates on the ground
     * that shares the same projected pixel coordinates with the specified
     * geographical location and altitude.
     * @param {LngLatLike} coord - The geographical location to adjust
     * @param {number} altitude - The altitude in meters of the position
     * @param {number} bearing - The desired bearing of the camera in degrees.
     *     If not specified, the coordinates will be calculated using the
     *     current camera projection matrix
     * @returns {LngLat} The adjusted LngLat.
     */
    adjustCoord(coord, altitude, bearing) {
        if (!altitude) {
            return LngLat.convert(coord);
        }

        const { map, trafficLayer } = this;

        if (!isNaN(bearing)) {
            const mCoord = MercatorCoordinate.fromLngLat(coord, altitude),
                offset = mCoord.z * Math.tan(map.getPitch() * DEGREE_TO_RADIAN),
                x = mCoord.x + offset * Math.sin(bearing * DEGREE_TO_RADIAN),
                y = mCoord.y - offset * Math.cos(bearing * DEGREE_TO_RADIAN);

            return new MercatorCoordinate(x, y, 0).toLngLat();
        }
        return map.unproject(trafficLayer.project(coord, altitude));
    }

    getLocalizedRailwayTitle(railway) {
        const me = this,
            title = (railway || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedTrainNameOrRailwayTitle(names, railway) {
        const me = this;

        return names ?
            names.map(name => name[me.lang] || name.en).join(me.dict['and']) :
            me.getLocalizedRailwayTitle(railway);
    }

    getLocalizedTrainTypeTitle(type) {
        const me = this,
            title = (type || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedStationTitle(array) {
        const me = this,
            stations = Array.isArray(array) ? array : [array];

        return stations.map(station => {
            const title = (station || {}).title || {};
            return title[me.lang] || title.en;
        }).join(me.dict['and']);
    }

    getLocalizedRailDirectionTitle(direction) {
        const me = this,
            title = (direction || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedDestinationTitle(destination, direction) {
        const me = this;

        return destination ?
            me.dict['for'].replace('$1', me.getLocalizedStationTitle(destination)) :
            me.getLocalizedRailDirectionTitle(direction);
    }

    getLocalizedOperatorTitle(operator) {
        const me = this,
            title = (operator || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedAirportTitle(airport) {
        const me = this,
            title = (airport || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedFlightStatusTitle(status) {
        const me = this,
            title = (status || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedPOITitle(poi) {
        const me = this,
            title = (poi || {}).title || {};

        return title[me.lang] || title.en;
    }

    getLocalizedPOIDescription(poi) {
        const me = this,
            description = (poi || {}).description || {};

        return description[me.lang] || description.en;
    }

    getTrainDescription(train) {
        const me = this,
            { lang, dict } = me,
            { r: railway, ad, departureTime, arrivalStation } = train,
            color = (ad && ad.color) || (train.v || railway).color,
            delay = train.delay || 0,
            arrivalTime = helpers.valueOrDefault(train.arrivalTime, train.nextDepartureTime),
            status = railway.status;

        if (train.liveTfL) {
            const headerColor = (train.v || railway).color || '#0098D4';
            const destinationLabel = train.destinationName
                ? dict['for'].replace('$1', train.destinationName)
                : me.getLocalizedRailDirectionTitle(train.d);
            const trainNumber = train.n || train.id;
            const prevStation = train.departureStation ? me.getLocalizedStationTitle(train.departureStation) : null;
            const nextStation = train.arrivalStation ? me.getLocalizedStationTitle(train.arrivalStation) : null;
            const prevTime = Number.isFinite(train._tflPrevTime) ? me.clock.getTimeString(train._tflPrevTime) : null;
            const nextTime = Number.isFinite(train._tflNextTime) ? me.clock.getTimeString(train._tflNextTime) : null;
            const previousStopLabel = dict['previous-stop'] || 'Previous stop';
            const nextStopLabel = dict['next-stop'] || 'Next stop';

            return [
                '<div class="desc-header">',
                Array.isArray(headerColor) ? [
                    '<div>',
                    ...headerColor.slice(0, 3).map(c => `<div class="line-strip" style="background-color: ${c};"></div>`),
                    '</div>'
                ].join('') : `<div style="background-color: ${headerColor};"></div>`,
                '<div><strong>',
                me.getLocalizedRailwayTitle(railway),
                '</strong>',
                `<br>${destinationLabel}`,
                '</div></div>',
                `<strong>${dict['train-number']}:</strong> ${trainNumber}`,
                prevStation ? `<br><strong>${previousStopLabel}:</strong> ${prevStation}${prevTime ? ` ${prevTime}` : ''}` : '',
                nextStation ? `<br><strong>${nextStopLabel}:</strong> ${nextStation}${nextTime ? ` ${nextTime}` : ''}` : ''
            ].join('');
        }

        return [
            '<div class="desc-header">',
            Array.isArray(color) ? [
                '<div>',
                ...color.slice(0, 3).map(c => `<div class="line-strip" style="background-color: ${c};"></div>`),
                '</div>'
            ].join('') : `<div style="background-color: ${color};"></div>`,
            '<div><strong>',
            me.getLocalizedTrainNameOrRailwayTitle(train.nm, railway),
            '</strong>',
            `<br> <span class="train-type-label">${me.getLocalizedTrainTypeTitle(train.y)}</span> `,
            me.getLocalizedDestinationTitle(train.ds, train.d),
            '</div></div>',
            `<strong>${dict['train-number']}:</strong> ${train.n}`,
            !train.timetable ? ` <span class="desc-caution">${dict['special']}</span>` : '',
            '<br>',
            ad ? `<span class="desc-ad-cars" style="color: ${ad.textcolor};">${ad.description[lang]}</span><br>` : '',
            delay >= 60000 ? '<span class="desc-caution">' : '',
            '<strong>',
            dict[train.standing ? 'standing-at' : 'previous-stop'],
            ':</strong> ',
            me.getLocalizedStationTitle(train.departureStation),
            departureTime !== undefined ? ` ${helpers.getTimeString(departureTime + delay)}` : '',
            arrivalStation ? [
                `<br><strong>${dict['next-stop']}:</strong> `,
                me.getLocalizedStationTitle(arrivalStation),
                arrivalTime !== undefined ? ` ${helpers.getTimeString(arrivalTime + delay)}` : ''
            ].join('') : '',
            delay >= 60000 ? `<br>${dict['delay'].replace('$1', Math.floor(delay / 60000))}</span>` : '',
            status && lang === 'ja' ? `<br><span class="desc-caution"><strong>${status}:</strong> ${railway.text}</span>` : ''
        ].join('');
    }

    getFlightDescription(flight) {
        const me = this,
            dict = me.dict,
            { a: airline, n: flightNumber, ds: destination } = flight,
            tailcolor = airline.tailcolor || '#FFFFFF',
            scheduledTime = helpers.valueOrDefault(flight.sdt, flight.sat),
            estimatedTime = helpers.valueOrDefault(flight.edt, flight.eat),
            actualTime = helpers.valueOrDefault(flight.adt, flight.aat),
            delayed = (estimatedTime !== undefined || actualTime !== undefined) && scheduledTime !== helpers.valueOrDefault(estimatedTime, actualTime);

        return [
            '<div class="desc-header">',
            `<div style="background-color: ${tailcolor};"></div>`,
            `<div><strong>${me.getLocalizedOperatorTitle(airline)}</strong>`,
            `<br>${flightNumber[0]} `,
            dict[destination ? 'to' : 'from'].replace('$1', me.getLocalizedAirportTitle(destination || flight.or)),
            '</div></div>',
            `<strong>${dict['status']}:</strong> ${me.getLocalizedFlightStatusTitle(flight.s)}`,
            '<br><strong>',
            dict[destination ? 'scheduled-departure-time' : 'scheduled-arrival-time'],
            `:</strong> ${helpers.getTimeString(scheduledTime)}`,
            delayed ? '<span class="desc-caution">' : '',
            estimatedTime !== undefined ? [
                '<br><strong>',
                dict[destination ? 'estimated-departure-time' : 'estimated-arrival-time'],
                `:</strong> ${helpers.getTimeString(estimatedTime)}`
            ].join('') : actualTime !== undefined ? [
                '<br><strong>',
                dict[destination ? 'actual-departure-time' : 'actual-arrival-time'],
                `:</strong> ${helpers.getTimeString(actualTime)}`
            ].join('') : '',
            delayed ? '</span>' : '',
            flightNumber.length > 1 ? `<br><strong>${dict['code-share']}:</strong> ${flightNumber.slice(1).join(' ')}` : ''
        ].join('');
    }

    getBusDescription(bus) {
        const me = this,
            dict = me.dict,
            gtfs = me.gtfs.get(bus.gtfsId),
            stopLookup = gtfs.stopLookup,
            { route, headsigns, stops } = bus.trip,
            { shortName, longName, color, textColor } = gtfs.routeLookup.get(route),
            labelStyle = [
                textColor ? `color: ${textColor};` : '',
                color ? `background-color: ${color};` : ''
            ].join(' '),
            nextStopIndex = bus.sectionIndex + (bus.standing ? 0 : bus.sectionLength),
            nextStopName = stopLookup.get(stops[nextStopIndex]).name,
            prevStopIndex = Math.max(0, nextStopIndex - 1),
            prevStopName = stopLookup.get(stops[prevStopIndex]).name;

        return [
            '<div class="desc-header">',
            `<div style="background-color: ${gtfs.color};"></div>`,
            `<div><strong>${gtfs.agency}</strong>`,
            bus.stop !== undefined ? '<span class="realtime-small-icon"></span>' : '',
            '<br>',
            shortName || longName ? ` <span class="bus-route-label" style="${labelStyle}">${shortName || longName}</span> ` : '',
            headsigns.length === 0 ? longName : headsigns[headsigns.length === 1 ? 0 : prevStopIndex],
            '</div></div>',
            bus.id ? `<strong>${dict['vehicle-number']}:</strong> ${bus.id}<br>` : '',
            `<strong>${dict['previous-busstop']}:</strong> ${prevStopName}<br>`,
            `<strong>${dict['next-busstop']}:</strong> ${nextStopName}`
        ].join('');
    }

    /**
     * Check if any of connecting trains is active
     * @param {Object} train - train to check
     * @returns {boolean} True if any of connecting trains is active
     */
    checkActiveTrains(train) {
        const me = this;

        function check(curr, prop) {
            const activeTrain = me.activeTrainLookup.get(curr.t);

            // Need to check timetable ID
            if (activeTrain && curr.id === activeTrain.timetable.id) {
                return true;
            }

            const timetables = curr[prop];

            if (timetables) {
                for (const timetable of timetables) {
                    if (check(timetable, prop)) {
                        return true;
                    }
                }
            }
            return false;
        }

        return train.timetable ? check(train.timetable, 'pt') || check(train.timetable, 'nt') : false;
    }

    stopTrain(train) {
        const me = this;

        animation.stop(train.animationID);
        me.hideAdTrainPopup(train);
        if (train === me.markedObject) {
            me.markObject();
        }
        if (train === me.trackedObject) {
            me.trackObject();
        }
        me.activeTrainLookup.delete(train.id);
        return me.trafficLayer.removeObject(train);
    }

    stopFlight(flight) {
        const me = this;

        animation.stop(flight.animationID);
        if (flight === me.markedObject) {
            me.markObject();
        }
        if (flight === me.trackedObject) {
            me.trackObject();
        }
        me.activeFlightLookup.delete(flight.id);
        return me.trafficLayer.removeObject(flight);
    }

    stopBus(bus) {
        const me = this;

        animation.stop(bus.animationID);
        if (bus === me.markedObject) {
            me.markObject();
        }
        if (bus === me.trackedObject) {
            me.trackObject();
        }
        me.gtfs.get(bus.gtfsId).activeBusLookup.delete(bus.trip.id);
        return me.trafficLayer.removeObject(bus);
    }

    stopAll() {
        const me = this,
            promises = [];

        for (const train of me.activeTrainLookup.values()) {
            promises.push(me.stopTrain(train));
        }
        me.standbyTrainLookup.clear();
        me.realtimeTrains.clear();
        me.adTrains.clear();
        for (const flight of me.activeFlightLookup.values()) {
            promises.push(me.stopFlight(flight));
        }
        for (const { activeBusLookup, realtimeBuses } of me.gtfs.values()) {
            for (const bus of activeBusLookup.values()) {
                promises.push(me.stopBus(bus));
            }
            realtimeBuses.clear();
        }
        if (promises.length > 0) {
            me.removing = true;
            Promise.all(promises).then(() => {
                delete me.removing;
                delete me.lastRefresh;
                delete me.lastRealtimeCheck;
            });
        }
    }

    resetRailwayStatus() {
        for (const railway of this.railways.getAll()) {
            delete railway.status;
            delete railway.text;
            delete railway.suspended;
        }
    }

    refreshTrainTimetableData() {
        const me = this;

        showLoader(me.container);
        me.timetables.clear();
        loadTimetableData(me.dataUrl, me.clock).then(data => {
            me.timetables = new TrainTimetables(data, me.dataReferences);
            delete me.lastRefresh;
            delete me.lastRealtimeCheck;
            hideLoader(me.container);
        });
    }

    refreshBusData(replace) {
        const me = this,
            map = me.map,
            sourceIds = new Set(me.dataSources.map(({ gtfsUrl }) => gtfsUrl)),
            deleteGtfs = ({ id, activeBusLookup, layerIds, routeGroupIndex, colorGroupIndex }) => {
                const styleOpacities = me.styleOpacities,
                    promises = [];

                for (const layerId of layerIds) {
                    me.removeLayer(layerId);
                    for (let i = 0, ilen = styleOpacities.length; i < ilen; i++) {
                        if (styleOpacities[i].id === layerId) {
                            styleOpacities.splice(i, 1);
                            break;
                        }
                    }
                }
                map.removeSource(id);
                for (const bus of activeBusLookup.values()) {
                    promises.push(me.stopBus(bus));
                }
                me.gtfs.delete(id);
                return Promise.all(promises).then(() => {
                    me.trafficLayer.removeRouteGroup(routeGroupIndex);
                    me.trafficLayer.removeColorGroup(colorGroupIndex);
                });
            };

        for (const [id, gtfs] of me.gtfs) {
            if (!sourceIds.has(id)) {
                deleteGtfs(gtfs);
            }
        }

        for (const source of me.dataSources) {
            const id = source.gtfsUrl;

            if (me.gtfs.has(id) && !replace) {
                continue;
            }

            loadBusData(source, me.clock, me.lang).then(data =>
                me.initialized ? data : new Promise(resolve => me.once('initialized', () => resolve(data)))
            ).then(data =>
                me.gtfs.has(id) ? deleteGtfs(me.gtfs.get(id)).then(() => data) : data
            ).then(data => {
                const { agency, featureCollection, version } = data,
                    featureLookup = new Map(),
                    stopLookup = new Map(),
                    routeLookup = new Map(),
                    tripLookup = new Map(),
                    layerIds = new Set(),
                    routeData = [];

                featureEach(featureCollection, feature => {
                    const properties = feature.properties;

                    if (properties.type === 0) {
                        featureLookup.set(properties.id, feature);
                        routeData.push({ id: `${id}.${properties.id}`, feature });
                    }
                });
                for (const stop of data.stops) {
                    stopLookup.set(stop.id, stop);
                }
                for (const route of data.routes) {
                    routeLookup.set(route.id, route);
                }
                for (const trip of data.trips) {
                    tripLookup.set(trip.id, trip);
                }
                me.gtfs.set(id, {
                    id,
                    agency,
                    version,
                    featureLookup,
                    stopLookup,
                    routeLookup,
                    tripLookup,
                    layerIds,
                    activeBusLookup: new Map(),
                    realtimeBuses: new Set(),
                    vehiclePositionUrl: source.vehiclePositionUrl,
                    color: source.color,
                    routeGroupIndex: me.trafficLayer.addRouteGroup(routeData),
                    colorGroupIndex: me.trafficLayer.addColorGroup([{ id, color: source.color }])
                });

                map.addSource(id, {
                    type: 'geojson',
                    data: featureCollection,
                    promoteId: 'id'
                });

                if (configs.city === 'london') {
                    const londonGeo = me.buildLondonRailGeoJSON();

                    map.addSource('london-rail', {
                        type: 'geojson',
                        data: londonGeo
                    });

                    map.addLayer({
                        id: 'london-railways',
                        type: 'line',
                        source: 'london-rail',
                        filter: ['==', ['get', 'type'], 'railway'],
                        paint: {
                            'line-color': ['get', 'color'],
                            'line-width': 4
                        }
                    }, 'trees');

                    map.addLayer({
                        id: 'london-stations',
                        type: 'circle',
                        source: 'london-rail',
                        filter: ['==', ['get', 'type'], 'station'],
                        paint: {
                            'circle-radius': 4,
                            'circle-color': '#ffffff',
                            'circle-stroke-width': 2,
                            'circle-stroke-color': '#000000'
                        }
                    }, 'trees');
                }

                for (const key of ['busroute', 'busroute-highlighted']) {
                    const width = key === 'busroute' ? ['get', 'width'] : ['*', ['get', 'width'], 4];

                    me.addLayer({
                        id: `${key}-${id}-og-`,
                        type: 'line',
                        source: id,
                        filter: ['==', ['get', 'type'], 0],
                        paint: {
                            'line-color': {
                                'busroute': ['get', 'color'],
                                'busroute-highlighted': ['string', ['feature-state', 'route-highlight'], ['feature-state', 'trip-highlight'], ['get', 'color']]
                            }[key],
                            'line-opacity': {
                                'busroute': [
                                    'case',
                                    ['to-boolean', ['feature-state', 'hidden']],
                                    0,
                                    1
                                ],
                                'busroute-highlighted': [
                                    'case',
                                    [
                                        'all',
                                        [
                                            'any',
                                            ['to-boolean', ['feature-state', 'route-highlight']],
                                            ['to-boolean', ['feature-state', 'trip-highlight']],
                                        ],
                                        ['!', ['to-boolean', ['feature-state', 'hidden']]]
                                    ],
                                    1,
                                    0
                                ]
                            }[key],
                            'line-width': [
                                'interpolate',
                                ['exponential', 2],
                                ['zoom'],
                                11,
                                ['/', width, 2],
                                12,
                                width,
                                19,
                                width,
                                22,
                                ['*', width, 8]
                            ],
                            'line-emissive-strength': 1
                        },
                        metadata: {
                            'busroute': {
                                'mt3d:opacity-effect': true,
                                'mt3d:opacity': 1,
                                'mt3d:opacity-route': 0.1,
                                'mt3d:opacity-underground': 0,
                                'mt3d:opacity-underground-route': 0
                            },
                            'busroute-highlighted': {
                                'mt3d:opacity-effect': true,
                                'mt3d:opacity': 1,
                                'mt3d:opacity-route': 0.1,
                                'mt3d:opacity-underground': 0.25,
                                'mt3d:opacity-underground-route': 0.1
                            }
                        }[key]
                    }, 'railways-og-13');
                    layerIds.add(`${key}-${id}-og-`);
                }

                for (const zoom of [14, 15, 16, 17, 18]) {
                    const interpolate = ['interpolate', ['exponential', 2], ['zoom']],
                        width = ['get', 'width'],
                        lineWidth = zoom === 18 ? [...interpolate, 19, width, 22, ['*', width, 8]] : width;

                    for (const key of ['busstops', 'busstops-outline']) {
                        me.addLayer({
                            id: `${key}-${id}-og-${zoom}`,
                            type: key === 'busstops' ? 'fill' : 'line',
                            source: id,
                            filter: ['all', ['==', ['get', 'zoom'], zoom], ['==', ['get', 'type'], 1]],
                            layout: {
                                visibility: zoom === me.layerZoom ? 'visible' : 'none'
                            },
                            paint: {
                                'busstops': {
                                    'fill-color': ['get', 'color'],
                                    'fill-opacity': .7,
                                    'fill-emissive-strength': 1
                                },
                                'busstops-outline': {
                                    'line-color': ['get', 'outlineColor'],
                                    'line-width': lineWidth,
                                    'line-emissive-strength': 1
                                }
                            }[key],
                            metadata: {
                                'mt3d:opacity-effect': true,
                                'mt3d:opacity': 1,
                                'mt3d:opacity-route': 0.1,
                                'mt3d:opacity-underground': 0.25,
                                'mt3d:opacity-underground-route': 0.1
                            }
                        }, 'railways-og-13');
                        layerIds.add(`${key}-${id}-og-${zoom}`);
                    }
                }

                me.addLayer({
                    id: `busstops-poi-${id}`,
                    type: 'symbol',
                    source: id,
                    filter: ['==', ['get', 'type'], 2],
                    layout: {
                        'text-field': ['get', 'name'],
                        'text-font': [
                            'Open Sans Bold',
                            'Arial Unicode MS Bold'
                        ],
                        'text-max-width': 9,
                        'text-padding': 2,
                        'text-size': 12,
                        'text-anchor': 'bottom',
                        'text-offset': [0, -1]
                    },
                    paint: {
                        'text-color': 'rgba(102,102,102,1)',
                        'text-halo-blur': 0.5,
                        'text-halo-color': 'rgba(255,255,255,1)',
                        'text-halo-width': 1
                    },
                    minzoom: 14
                });
                layerIds.add(`busstops-poi-${id}`);

                const styleOpacities = me.styleOpacities,
                    existingLayerIds = new Set(styleOpacities.map(({ id }) => id));

                for (const item of helpersMapbox.getStyleOpacities(map, 'mt3d:opacity-effect')) {
                    if (!existingLayerIds.has(item.id)) {
                        styleOpacities.push(item);
                    }
                }
                me.refreshMap();

                if (me.searchMode === 'none') {
                    if (me.clockMode === 'playback') {
                        me.refreshBuses(id);
                    } else if (me.clockMode === 'realtime') {
                        me.refreshRealtimeBusData(id);
                    }
                }
            });
        }

        me.updateBusRouteVisibility();
    }

    refreshRealtimeTrainData() {
        if (!configs.tidUrl) {
            return;
        }

        const me = this;

        loadDynamicTrainData(me.secrets).then(({ trainData, trainInfoData }) => {
            const { activeTrainLookup, standbyTrainLookup, realtimeTrains, dataReferences } = me,
                now = me.clock.getTimeOffset();

            me.resetRailwayStatus();

            for (const trainInfoRef of trainInfoData) {
                const railway = me.railways.get(trainInfoRef.railway),
                    status = trainInfoRef.status;

                // Train information text is provided in Japanese only
                if (railway && status && status.ja) {
                    railway.status = status.ja;
                    railway.text = trainInfoRef.text.ja;
                }

                if (trainInfoRef.suspended) {
                    railway.suspended = true;
                }
            }

            standbyTrainLookup.clear();
            realtimeTrains.clear();

            for (const trainRef of trainData) {
                const { id, r, n, y, d, os, ds, ts, fs, v, ad, delay, carComposition } = trainRef,
                    aliasId = id.replace('.Marunouchi.', '.MarunouchiBranch.');

                me.lastDynamicUpdate[trainRef.o] = trainRef.date;
                realtimeTrains.add(trainRef.id);

                // Retry lookup replacing Marunouchi line with MarunouchiBranch line
                const activeTrain = activeTrainLookup.get(id) || activeTrainLookup.get(aliasId);

                let marked, tracked;

                // Update the avtive train if exists
                if (activeTrain) {
                    if ((y && y !== activeTrain.y.id) ||
                        (os && activeTrain.os && os[0] !== activeTrain.os[0].id) ||
                        (ds && activeTrain.ds && ds[0] !== activeTrain.ds[0].id) ||
                        (v && v !== (activeTrain.v || {}).id) ||
                        (ad && !activeTrain.ad) ||
                        (!isNaN(carComposition) && carComposition !== activeTrain.carComposition) ||
                        (!isNaN(delay) && delay !== activeTrain.delay)) {
                        marked = me.markedObject === activeTrain;
                        tracked = me.trackedObject === activeTrain;
                        me.stopTrain(activeTrain);
                    } else {
                        if (!activeTrain.timetable) {
                            activeTrain.update({ ts, fs }, dataReferences);
                        }
                        continue;
                    }
                }

                let timetables = me.timetables.getByTrainId(id);

                // Retry lookup replacing Marunouchi line with MarunouchiBranch line
                if (timetables.length === 0) {
                    timetables = me.timetables.getByTrainId(aliasId);
                }

                // Start train with timetable
                if (timetables.length !== 0) {
                    for (const timetable of timetables) {
                        const train = new Train(timetable);

                        train.update({ y, os, ds, v, ad, delay, carComposition }, dataReferences);
                        if (timetable.start + (delay || 0) <= now && now <= timetable.end + (delay || 0)) {
                            me.trainStart(train, { marked, tracked });
                        } else {
                            standbyTrainLookup.set(timetable.id, train);
                        }
                    }
                    continue;
                }

                if (!r) {
                    continue;
                }

                // Exclude Namboku line trains that connect to/from Mita line
                if (r === RAILWAY_NAMBOKU && (os[0].startsWith(RAILWAY_MITA) || ds[0].startsWith(RAILWAY_MITA))) {
                    continue;
                }

                // Exclude Arakawa line trains
                if (r === RAILWAY_ARAKAWA) {
                    continue;
                }

                // Start train without timetable
                me.trainStart(new Train({ id, r, n, y, d, os, ds, ts, fs, delay, carComposition }, dataReferences));
            }

            // Stop trains if they are no longer active
            for (const train of activeTrainLookup.values()) {
                const railway = train.r;

                if ((((railway.status && railway.dynamic) || !train.timetable) && !realtimeTrains.has(train.id)) || railway.suspended) {
                    me.stopTrain(train);
                }
            }

            me.refreshTrains();
            me.aboutPanel.updateContent();
        }).catch(error => {
            me.refreshTrains();
            console.log(error);
        });
    }

    refreshRealtimeFlightData() {
        if (!configs.flightUrl && !configs.atisUrl) {
            return;
        }
        const me = this;

        loadDynamicFlightData(me.secrets).then(({ atisData, flightData }) => {
            const flightLookup = me.flightLookup,
                { landing, departure } = atisData,
                pattern = [landing.join('/'), departure.join('/')].join(' '),
                codeShareFlights = {},
                flightQueue = {};
            let arrRoutes = {},
                depRoutes = {},
                north = true;

            if (me.flightPattern !== pattern) {
                me.flightPattern = pattern;
                me.lastFlightPatternChanged = Date.now();
                for (const flight of me.activeFlightLookup.values()) {
                    me.stopFlight(flight);
                }
            }

            if (helpers.includes(landing, ['R16L', 'R16R'])) { // South wind, good weather, rush hour
                arrRoutes = { S: 'R16L', N: 'R16R' };
                depRoutes = { S: '22', N: '16R' };
                north = false;
            } else if (helpers.includes(landing, ['L22', 'L23'])) { // South wind, good weather
                arrRoutes = { S: 'L23', N: 'L22' };
                depRoutes = { S: 'O16R', N: '16L' };
                north = false;
            } else if (helpers.includes(landing, ['I16L', 'I16R'])) { // South wind, bad weather, rush hour
                arrRoutes = { S: 'I16L', N: 'I16R' };
                depRoutes = { S: '22', N: '16R' };
                north = false;
            } else if (helpers.includes(landing, ['I22', 'I23'])) { // South wind, bad weather
                arrRoutes = { S: 'I23', N: 'I22' };
                depRoutes = { S: '16R', N: '16L' };
                north = false;
            } else if (helpers.includes(landing, ['I34L', 'H34R'])) { // North wind, good weather
                arrRoutes = { S: 'IX34L', N: 'H34R' };
                depRoutes = { S: '05', N: '34R' };
                north = true;
            } else if (helpers.includes(landing, ['I34L', 'I34R'])) { // North wind, bad weather
                arrRoutes = { S: 'IZ34L', N: 'H34R' };
                depRoutes = { S: '05', N: '34R' };
                north = true;
            } else if (landing.length !== 1) {
                console.log(`Unexpected RWY: ${landing}`);
            } else { // Midnight
                if (helpers.includes(landing, 'I23')) {
                    arrRoutes = { S: 'IY23', N: 'IY23' };
                    north = false;
                } else if (helpers.includes(landing, 'L23')) {
                    arrRoutes = { S: 'LY23', N: 'LY23' };
                    north = false;
                } else if (helpers.includes(landing, 'I34L')) {
                    arrRoutes = { S: 'IX34L', N: 'IX34L' };
                    north = true;
                } else if (helpers.includes(landing, 'I34R')) {
                    arrRoutes = { S: 'IY34R', N: 'IY34R' };
                    north = true;
                } else if (helpers.includes(landing, 'L22')) { // Special
                    arrRoutes = { S: 'L22', N: 'L22' };
                    north = false;
                } else {
                    console.log(`Unexpected LDG RWY: ${landing[0]}`);
                }
                if (helpers.includes(departure, '16L')) {
                    depRoutes = { S: 'N16L', N: 'N16L' };
                } else if (helpers.includes(departure, '05')) {
                    depRoutes = { S: 'N05', N: 'N05' };
                } else if (helpers.includes(departure, '16R')) { // Special
                    depRoutes = { S: '16R', N: '16R' };
                } else {
                    console.log(`Unexpected DEP RWY: ${departure[0]}`);
                }
            }

            // Create code share flight lookup
            for (const flightRef of flightData) {
                if (helpers.includes(AIRLINES_FOR_ANA_CODE_SHARE, flightRef.a)) {
                    const { dp, ds, sdt, or, ar, sat } = flightRef,
                        key = `${dp || or}.${ds || ar}.${sdt || sat}`;

                    codeShareFlights[key] = flightRef;
                }
            }

            for (const flightRef of flightData) {
                const { id, n, dp, ds, sdt, or, ar, sat } = flightRef;
                let flight = flightLookup.get(id),
                    status = flightRef.s,
                    { maxFlightSpeed: maxSpeed, flightAcceleration: acceleration } = configs;

                // Check code share flight
                if (id.match(/NH\d{4}$/)) {
                    const key = `${dp || or}.${ds || ar}.${sdt || sat}`,
                        codeShareFlight = codeShareFlights[key];

                    if (codeShareFlight) {
                        codeShareFlight.n.push(...n);
                        continue;
                    }
                }

                if (!flight) {
                    if (helpers.includes(['Cancelled', 'PostponedTomorrow'], status)) {
                        continue;
                    }
                    const airport = me.airports.get(ds || or),
                        direction = airport ? airport.direction : 'S',
                        route = dp === 'NRT' ? `NRT.${north ? '34L' : '16R'}.Dep` :
                            ar === 'NRT' ? `NRT.${north ? '34R' : '16L'}.Arr` :
                                dp === 'HND' ? `HND.${depRoutes[direction]}.Dep` :
                                    ar === 'HND' ? `HND.${arrRoutes[direction]}.Arr` : undefined,
                        feature = me.featureLookup.get(route);

                    if (feature) {
                        flight = new Flight({
                            id,
                            n,
                            a: flightRef.a,
                            dp,
                            ar,
                            ds,
                            or
                        }, {
                            airports: me.airports,
                            operators: me.operators
                        });
                        flight.runway = route.replace(/^([^.]+\.)[A-Z]*([^.]+).+/, '$1$2');
                        flight.feature = feature;
                        flightLookup.set(flight.id, flight);
                    } else {
                        continue;
                    }
                }
                flight.update({
                    edt: flightRef.edt,
                    adt: flightRef.adt,
                    sdt,
                    eat: flightRef.eat,
                    aat: flightRef.aat,
                    sat
                });

                const departureTime = helpers.valueOrDefault(flight.edt, helpers.valueOrDefault(flight.adt, flight.sdt)),
                    arrivalTime = helpers.valueOrDefault(flight.eat, helpers.valueOrDefault(flight.aat, flight.sat));

                if (arrivalTime !== undefined && !status) {
                    if (arrivalTime < flight.sat) {
                        status = 'NewTime';
                    } else if (arrivalTime > flight.sat) {
                        status = 'Delayed';
                    } else if (arrivalTime === flight.sat) {
                        status = 'OnTime';
                    }
                } else if (departureTime !== undefined && (!status || status === 'CheckIn' || status === 'NowBoarding' || status === 'FinalCall' || status === 'BoardingComplete' || status === 'Departed')) {
                    if (departureTime < flight.sdt) {
                        status = 'NewTime';
                    } else if (departureTime > flight.sdt) {
                        status = 'Delayed';
                    } else if (departureTime === flight.sdt) {
                        status = 'OnTime';
                    }
                }
                flight.update({ s: status }, { flightStatuses: me.flightStatuses });

                if (arrivalTime !== undefined) {
                    maxSpeed /= 2;
                    acceleration /= -2;
                }

                const duration = maxSpeed / Math.abs(acceleration) / 2 + flight.feature.properties.length / maxSpeed,
                    standingDuration = configs.standingDuration;

                if (departureTime) {
                    flight.start = flight.base = departureTime;
                    flight.entry = flight.start - standingDuration;
                    flight.end = flight.start + duration;
                } else {
                    flight.start = flight.entry = arrivalTime - duration;
                    flight.base = flight.start + duration - standingDuration;
                    flight.end = flight.start + duration + standingDuration;
                }
                flight.maxSpeed = maxSpeed;
                flight.acceleration = acceleration;

                const queue = flightQueue[flight.runway] = flightQueue[flight.runway] || [];
                queue.push(flight);

                me.lastDynamicUpdate[flightRef.o] = flightRef.date;
            }

            for (const key of Object.keys(flightQueue)) {
                const queue = flightQueue[key];
                let latest = 0;

                queue.sort((a, b) => a.base - b.base);
                for (const flight of queue) {
                    const base = flight.base,
                        delay = Math.max(base, latest + configs.minFlightInterval) - base;

                    if (delay) {
                        flight.start += delay;
                        flight.base += delay;
                        flight.entry += delay;
                        flight.end += delay;
                    }
                    latest = flight.base;
                }
            }

            me.refreshFlights();
            me.aboutPanel.updateContent();
        }).catch(error => {
            me.refreshFlights();
            console.log(error);
        });
    }

    refreshRealtimeBusData(gtfsId) {
        const me = this;

        for (const gtfs of gtfsId ? [me.gtfs.get(gtfsId)] : me.gtfs.values()) {
            const { id: gtfsId, vehiclePositionUrl, featureLookup, stopLookup, routeLookup, tripLookup, activeBusLookup, realtimeBuses } = gtfs;

            if (!vehiclePositionUrl) {
                me.refreshBuses(gtfsId);
                continue;
            }

            loadDynamicBusData(vehiclePositionUrl).then(data => {
                realtimeBuses.clear();
                gtfs.date = me.clock.getString(data.header.timestamp * 1000);

                for (const { id, vehicle: vp } of data.entity) {
                    if (!vp) {
                        continue;
                    }

                    const vehicle = vp.vehicle,
                        stop = vp.currentStopSequence,
                        position = vp.position,
                        tripId = vp.trip && vp.trip.tripId;

                    if (!(stop || position) || !tripId) {
                        continue;
                    }

                    realtimeBuses.add(tripId);

                    const busTrip = tripLookup.get(tripId),
                        feature = busTrip && featureLookup.get(busTrip.shape),
                        route = busTrip && routeLookup.get(busTrip.route);

                    if (!busTrip || !feature || !route || route.hidden) {
                        continue;
                    }

                    const isActive = activeBusLookup.has(tripId);
                    let bus;

                    if (isActive) {
                        bus = activeBusLookup.get(tripId);
                    } else {
                        let offset = 0;
                        const offsets = busTrip.stops.map(stopId =>
                            // Use the previous offset to calulate a weight and pick a closer point
                            (offset = nearestCloserPointOnLine(feature, stopLookup.get(stopId).coord, offset).properties.location)
                        );

                        bus = {
                            type: 'bus',
                            id: vehicle ? vehicle.licensePlate || vehicle.id : id,
                            gtfsId,
                            trip: busTrip,
                            feature,
                            offsets,
                            offset: 0
                        };
                    }
                    if (stop) {
                        bus.stop = stop;
                    } else {
                        const offsets = bus.offsets,
                            // Use the current bus.offset to calulate a weight and pick a closer point
                            offset = nearestCloserPointOnLine(feature, [position.longitude, position.latitude], bus.offset).properties.location;

                        bus.stop = busTrip.stopSequences[offsets.reduce(
                            (acc, cur, i) => cur < offset ? Math.min(i + 1, offsets.length - 1) : acc, 0
                        )];
                    }
                    if (!isActive) {
                        me.busStart(bus);
                    }
                }

                me.aboutPanel.updateContent();
            }).catch(error => {
                console.log(error);
            });
        }
    }

    updateUndergroundButton(mode) {
        const { container, dict } = this,
            button = container.querySelector('.mapboxgl-ctrl-underground');

        if (button) {
            const classList = button.classList;

            if (mode === 'underground') {
                button.title = dict['exit-underground'];
                classList.add('mapboxgl-ctrl-underground-visible');
            } else {
                button.title = dict['enter-underground'];
                classList.remove('mapboxgl-ctrl-underground-visible');
            }
        }
    }

    updatePlaybackButton(mode) {
        const { container, dict } = this,
            button = container.querySelector('.mapboxgl-ctrl-playback');

        if (button) {
            const classList = button.classList;

            if (mode === 'playback') {
                button.title = dict['exit-playback'];
                classList.add('mapboxgl-ctrl-playback-active');
            } else {
                button.title = dict['enter-playback'];
                classList.remove('mapboxgl-ctrl-playback-active');
            }
        }
    }

    updateEcoButton(mode) {
        const { container, dict } = this,
            button = container.querySelector('.mapboxgl-ctrl-eco');

        if (button) {
            const classList = button.classList;

            if (mode === 'eco') {
                button.title = dict['exit-eco'];
                classList.add('mapboxgl-ctrl-eco-active');
            } else {
                button.title = dict['enter-eco'];
                classList.remove('mapboxgl-ctrl-eco-active');
            }
        }
    }

    refreshMap() {
        const me = this,
            { viewMode, searchMode } = me,
            isUndergroundMode = viewMode === 'underground',
            isNotSearchResultMode = searchMode === 'none' || searchMode === 'edit',
            factorKey = `mt3d:opacity${isUndergroundMode ? '-underground' : ''}`;

        helpersMapbox.setStyleOpacities(me.map, me.styleOpacities, isNotSearchResultMode ? factorKey : [`${factorKey}-route`, factorKey]);
        me.trafficLayer.setMode(viewMode, searchMode);
    }

    _setSearchMode(mode) {
        const me = this;

        if (me.searchMode !== mode) {
            me.searchMode = mode;
            me.stopAll();
            for (const plugin of me.plugins) {
                plugin.setVisibility(mode === 'none');
            }
            me.refreshMap();
        }
    }

    _setViewMode(mode) {
        const me = this;

        if (me.viewMode === mode) {
            return;
        }

        me.updateUndergroundButton(mode);
        me.viewMode = mode;
        me.refreshMap();
        me.fire({ type: 'viewmode', mode });
    }

    _setTrackingMode(mode) {
        const me = this;

        if (me.trackingMode === mode) {
            return;
        }

        me.trackingMode = mode;
        if (isVehicle(me.trackedObject)) {
            me.updateBaseZoom();
            me.updateTrackingParams(true);
            me.updateHandlersAndControls();
            me.startViewAnimation();
        }
        me.fire({ type: 'trackingmode', mode });
    }

    _setClockMode(mode) {
        const me = this;

        if (me.clockMode === mode) {
            return;
        }

        me.updatePlaybackButton(mode);
        me.clockMode = mode;
        me.clock.reset();
        me.onClockChange();
        if (me.clockControl) {
            me.clockCtrl.setMode(mode);
        }
        if (mode === 'playback') {
            me.resetRailwayStatus();
        }
        me.fire({ type: 'clockmode', mode });
    }

    _setEcoMode(mode) {
        const me = this;

        if (me.ecoMode === mode) {
            return;
        }

        me.updateEcoButton(mode);
        me.ecoMode = mode;
        me.fire({ type: 'ecomode', mode });
    }

    onClockChange() {
        const me = this,
            baseTime = me.clock.getTime('03:00');

        me.stopAll();
        me.markObject();
        me.trackObject();

        if (me.lastTimetableRefresh !== baseTime) {
            me.refreshTrainTimetableData();
            me.lastTimetableRefresh = baseTime;
        }
    }

    /**
     * Returns the light color based on the current date and time.
     * In the playback mode, the time in the simulation clock is used.
     * @returns {Object} Color object
     */
    getLightColor() {
        return helpersMapbox.getSunlightColor(this.map, this.clock.getTime());
    }

    pickObject(point) {
        const me = this,
            { map, layerZoom } = me,
            modes = ['ground', 'underground'];
        let object;

        if (me.viewMode === 'underground') {
            modes.reverse();
        }
        for (const mode of modes) {
            object = me.trafficLayer.pickObject(mode, point);
            if (object) {
                return object;
            }
            if (mode === 'ground') {
                object = map.queryRenderedFeatures(point, { layers: [`stations-og-${layerZoom}`] })[0];
            } else {
                object = pickObject(map, `stations-ug-${layerZoom}`, point);
            }
            if (object) {
                return me.stationGroupLookup.get(object.properties.group);
            }
        }
    }

    markObject(object) {
        const me = this,
            { markedObject, trafficLayer, map, popup } = me;

        if (isEqualObject(markedObject, object)) {
            return;
        }

        if (markedObject) {
            delete me.markedObject;
            if (isVehicle(markedObject)) {
                trafficLayer.markObject();
                if (markedObject.type === 'bus') {
                    me.updateBusTripHighlight(markedObject);
                }
            } else {
                me.removeStationOutline('stations-marked');
            }
            if (popup && popup.isOpen()) {
                map.getCanvas().style.cursor = '';
                popup.remove();
            }
        }

        if (object) {
            me.markedObject = object;
            if (isVehicle(object)) {
                me.updateObjectPosition(object);
                trafficLayer.markObject(object);
                if (object.type === 'bus') {
                    me.updateBusTripHighlight(object);
                }
            } else {
                me.addStationOutline(object, 'stations-marked');
            }

            map.getCanvas().style.cursor = 'pointer';
            me.popup = new AnimatedPopup({
                className: helpers.isTouchDevice() ? 'popup-object popup-touch' : 'popup-object',
                closeButton: false,
                closeOnClick: false,
                maxWidth: '300px',
                offset: {
                    top: [0, 10],
                    bottom: [0, -30]
                },
                openingAnimation: {
                    duration: 300,
                    easing: 'easeOutBack'
                }
            });
            me.updatePopup({ setHTML: true, addToMap: true });
        }
        me.updateAdTrainPopup();
        map.triggerRepaint();
    }

    trackObject(object) {
        const me = this,
            { searchMode, lang, map, trackedObject, trafficLayer, lastCameraParams, sharePanel, detailPanel } = me;

        if (searchMode === 'edit' && detailPanel && isStation(object)) {
            const { title, utitle } = object.stations[0],
                stationTitle = (utitle && utitle[lang]) || helpers.normalize(title[lang] || title.en);

            detailPanel.fillStationName(stationTitle);
            return;
        }

        if (isEqualObject(trackedObject, object)) {
            if ((isVehicle(object) || isStation(object)) && detailPanel) {
                detailPanel.reset();
            }
            return;
        }

        // Remember the camera params to restore them after the object is deselected
        if (!trackedObject && object) {
            lastCameraParams.viewMode = me.getViewMode();
            delete lastCameraParams.center;
            lastCameraParams.zoom = map.getZoom();
            lastCameraParams.bearing = map.getBearing();
            lastCameraParams.pitch = map.getPitch();
        } else if (trackedObject && !object) {
            me._setViewMode(lastCameraParams.viewMode);
            map.flyTo({
                center: lastCameraParams.center || map.getCenter(),
                zoom: lastCameraParams.zoom,
                bearing: lastCameraParams.bearing,
                pitch: lastCameraParams.pitch
            });
        }

        if (trackedObject) {
            delete me.trackedObject;
            if (isVehicle(trackedObject)) {
                trafficLayer.trackObject();
                if (trackedObject.type === 'bus') {
                    me.updateBusTripHighlight(trackedObject);
                }
                me.fire({ type: 'deselection', deselection: trackedObject.id });
            } else if (isStation(trackedObject)) {
                me.removeStationOutline('stations-selected');
                me.fire({ type: 'deselection', deselection: trackedObject.stations.map(({ id }) => id) });
                me._setSearchMode('none');
                me.hideStationExits();
            } else {
                me.fire(Object.assign({ type: 'deselection' }, trackedObject));
            }
            me.updateHandlersAndControls();
            me.stopViewAnimation();
            if (sharePanel) {
                sharePanel.remove();
                delete me.sharePanel;
            }
            if (detailPanel) {
                detailPanel.remove();
                delete me.detailPanel;
            }
        }

        if (object) {
            me.trackedObject = object;

            if (isVehicle(object)) {
                me.updateObjectPosition(object);
                me.updateBaseZoom();
                me.updateTrackingParams(true);
                me.updateHandlersAndControls();
                me.startViewAnimation();
                me._setViewMode(object.altitude < 0 ? 'underground' : 'ground');

                if (helpers.includes(['train', 'flight'], object.type) && me.clockMode === 'realtime' && navigator.share) {
                    me.sharePanel = new SharePanel({ object });
                    me.sharePanel.addTo(me);
                }
                if (object.timetable) {
                    me.detailPanel = new TrainPanel({ object });
                    me.detailPanel.addTo(me);
                } else if (object.trip) {
                    me.detailPanel = new BusPanel({ object });
                    me.detailPanel.addTo(me);
                }

                trafficLayer.trackObject(object);
                if (object.type === 'bus') {
                    me.updateBusTripHighlight(object);
                }
                me.fire({ type: 'selection', selection: object.id });
            } else if (isStation(object)) {
                const stations = object.stations.concat(object.hidden || []),
                    coords = stations.map(station => station.coord),
                    center = lastCameraParams.center = helpersMapbox.getBounds(coords).getCenter();

                if (object.layer === 'ground') {
                    me._setViewMode('ground');
                } else if (!map.getCenter().distanceTo(center)) {
                    me._setViewMode('underground');
                } else {
                    let prevZoom = map.getZoom();
                    const initialZoom = prevZoom,
                        onZoom = () => {
                            const zoom = map.getZoom();

                            if (zoom < prevZoom && zoom < initialZoom - 0.5) {
                                me._setViewMode('ground');
                            } else if (zoom > prevZoom && zoom > 15) {
                                me._setViewMode('underground');
                            }
                            prevZoom = zoom;
                        };

                    map.on('zoom', onZoom);
                    map.once('zoomend', () => {
                        me._setViewMode('underground');
                        map.off('zoom', onZoom);
                    });
                }
                map.flyTo({ center, zoom: 15.5 });

                me.detailPanel = new StationPanel({ object: stations });
                me.detailPanel.addTo(me);

                me.addStationOutline(object, 'stations-selected');
                me.fire({ type: 'selection', selection: object.stations.map(({ id }) => id) });
            } else {
                me.fire(Object.assign({ type: 'selection' }, object));
            }
        }
    }

    updateObjectPosition(object) {
        const { altitude: prevAltitude, standing: prevStanding } = object,
            { coord, altitude, bearing, _t } = this.trafficLayer.getObjectPosition(object);
        let viewMode, standing;

        object.coord = coord;
        object.altitude = altitude;
        object.bearing = bearing;
        object._t = _t;
        object.standing = _t === 0 || _t === 1;
        if (prevAltitude < 0 && altitude >= 0) {
            viewMode = 'ground';
        } else if (prevAltitude >= 0 && altitude < 0) {
            viewMode = 'underground';
        }
        if (prevStanding && !object.standing) {
            // Set only when starting
            standing = object.standing;
        }
        return { viewMode, standing };
    }

    showAdTrainPopup(train) {
        const me = this,
            adTrains = me.adTrains;

        if (adTrains.has(train)) {
            return;
        }

        const ad = train.ad;

        train.popup = new AnimatedPopup({
            className: 'popup-ad-cars',
            closeButton: false,
            closeOnClick: false,
            offset: {
                top: [0, 10],
                bottom: [0, -30]
            }
        });
        train.popup.setHTML(`<span style="color: ${ad.textcolor};">${ad.title[me.lang]}</span>`);
        adTrains.add(train);
        me.updateObjectPosition(train);
        me.updateAdTrainPopup();
    }

    updateAdTrainPopup() {
        const me = this,
            markedObject = me.markedObject;

        for (const train of me.adTrains) {
            train.popup.setLngLat(me.adjustCoord(train.coord, train.altitude));
            if (train !== markedObject && !train.popupVisible) {
                train.popup.addTo(me.map);
                train.popupVisible = true;
            } else if (train === markedObject && train.popupVisible) {
                train.popup.remove();
                delete train.popupVisible;
            }
        }
    }

    hideAdTrainPopup(train) {
        const me = this,
            adTrains = me.adTrains;

        if (!adTrains.has(train) || !train.popup) {
            return;
        }
        train.popup.remove();
        delete train.popup;
        delete train.popupVisible;
        adTrains.delete(train);
    }

    showStationExits(stations) {
        const me = this,
            map = me.map,
            exits = [].concat(...stations.map(station => station.exit || []));

        if (exits.length > 0) {
            const coords = [];

            me.exitPopups = exits.map((poi, index) => {
                const { coord, facilities = [] } = poi,
                    icons = facilities.map(facility => `<span class="exit-${facility}-small-icon"></span>`).join(''),
                    listener = () => {
                        me.exitPopups[index] = setTimeout(() => {
                            const popup = new AnimatedPopup({
                                className: 'popup-exit',
                                closeButton: false,
                                closeOnClick: false
                            });

                            popup.setLngLat(coord)
                                .setHTML(icons + me.getLocalizedPOITitle(poi))
                                .addTo(map)
                                .getElement().id = `exit-${index}`;

                            me.exitPopups[index] = popup;
                        }, index / exits.length * 1000);
                    };

                map.once('moveend', listener);
                coords.push(coord);

                return listener;
            });

            map.fitBounds(helpersMapbox.getBounds(coords), {
                bearing: map.getBearing(),
                pitch: map.getPitch(),
                offset: [0, -map.transform.height / 12],
                padding: { top: 20, bottom: 20, left: 10, right: 50 },
                maxZoom: 18
            });
        }
    }

    hideStationExits() {
        const me = this;

        for (const popup of me.exitPopups) {
            if (popup instanceof AnimatedPopup) {
                popup.remove();
            } else if (typeof popup === 'function') {
                me.map.off('moveend', popup);
            } else {
                clearTimeout(popup);
            }
        }
        me.exitPopups = [];
    }

    updateBaseZoom() {
        const me = this,
            { map, trackedObject: object } = me;

        if (isVehicle(object)) {
            const objectZ = me.getModelPosition(object.coord, object.altitude).z,
                cameraZ = map.getFreeCameraOptions().position.z;

            me.baseZoom = map.getZoom() + Math.log2(cameraZ / Math.abs(cameraZ - objectZ));
        }
    }

    updatePopup(options) {
        const me = this,
            { markedObject, map, popup } = me,
            { setHTML, addToMap } = options || {};

        if (isVehicle(markedObject)) {
            const bearing = markedObject === me.trackedObject ? map.getBearing() : undefined;

            popup.setLngLat(me.adjustCoord(markedObject.coord, markedObject.altitude, bearing));
            if (setHTML) {
                popup.setHTML(
                    markedObject.type === 'train' ? me.getTrainDescription(markedObject) :
                        markedObject.type === 'flight' ? me.getFlightDescription(markedObject) :
                            me.getBusDescription(markedObject)
                );
            }
        } else {
            const object = me.featureLookup.get(`${markedObject.id}.${me.layerZoom}`),
                coord = helpersGeojson.getCenterCoord(object),
                altitude = helpersGeojson.getAltitude(object);

            popup.setLngLat(me.adjustCoord(coord, altitude));
            if (setHTML) {
                const stations = markedObject.stations,
                    railwayColors = {};

                for (const station of stations) {
                    const title = me.getLocalizedStationTitle(station),
                        railway = station.railway,
                        colors = railwayColors[title] = railwayColors[title] || {};

                    colors[me.getLocalizedRailwayTitle(railway)] = railway.color;
                }
                popup.setHTML([
                    '<div class="thumbnail-image-container">',
                    '<div class="ball-pulse"><div></div><div></div><div></div></div>',
                    `<div class="thumbnail-image" style="background-image: url(\'${stations[0].thumbnail}\');"></div>`,
                    '</div>',
                    '<div class="railway-list">',
                    Object.keys(railwayColors).map(stationTitle => {
                        const railwayTitles = Object.keys(railwayColors[stationTitle])
                            .map(railwayTitle => `<div class="line-strip" style="background-color: ${railwayColors[stationTitle][railwayTitle]};"></div><span>${railwayTitle}</span>`)
                            .join('<br>');

                        return `<strong>${stationTitle}</strong><br>${railwayTitles}`;
                    }).join('<br>'),
                    '</div>'
                ].join(''));
            }
        }
        if (addToMap) {
            popup.addTo(map);
        }
    }

    updateBusRouteVisibility() {
        const me = this,
            map = me.map;

        for (const gtfs of me.gtfs.values()) {
            const source = gtfs.id,
                shapes = new Set();

            for (const route of gtfs.routeLookup.values()) {
                if (!route.hidden) {
                    for (const shape of route.shapes) {
                        shapes.add(shape);
                    }
                }
            }
            for (const id of gtfs.featureLookup.keys()) {
                if (shapes.has(id)) {
                    map.removeFeatureState({ source, id }, 'hidden');
                } else {
                    map.setFeatureState({ source, id }, { hidden: true });
                }
            }
            for (const bus of gtfs.activeBusLookup.values()) {
                const route = gtfs.routeLookup.get(bus.trip.route);

                if (!route || route.hidden) {
                    me.stopBus(bus);
                }
            }
        }
        delete me.lastRefresh;
        delete me.lastRealtimeCheck;
    }

    updateBusRouteHighlight(gtfsId, routeId) {
        const me = this,
            map = me.map;

        if (gtfsId) {
            const gtfs = me.gtfs.get(gtfsId),
                route = gtfs.routeLookup.get(routeId);

            for (const id of route.shapes) {
                map.setFeatureState({ source: gtfsId, id }, { 'route-highlight': route.color || gtfs.color });
            }
        } else {
            for (const gtfs of me.gtfs.values()) {
                for (const id of gtfs.featureLookup.keys()) {
                    map.removeFeatureState({ source: gtfs.id, id }, 'route-highlight');
                }
            }
        }
    }

    updateBusTripHighlight(object) {
        const me = this,
            { map, markedObject, trackedObject } = me,
            { gtfsId, trip } = object,
            source = gtfsId,
            id = trip.shape;

        if ((markedObject && markedObject.type === 'bus' && markedObject.gtfsId === gtfsId && markedObject.trip.shape === id) ||
            (trackedObject && trackedObject.type === 'bus' && trackedObject.gtfsId === gtfsId && trackedObject.trip.shape === id)) {
            const gtfs = me.gtfs.get(gtfsId),
                color = gtfs.routeLookup.get(trip.route).color;

            map.setFeatureState({ source, id }, { 'trip-highlight': color || gtfs.color });
        } else {
            map.removeFeatureState({ source, id }, 'trip-highlight');
        }
    }

    addStationOutline(object, name) {
        const me = this,
            id = object.stations[0].id;

        for (const zoom of [13, 14, 15, 16, 17, 18]) {
            helpersMapbox.setLayerProps(me.map, `${name}-${zoom}`, {
                data: helpersGeojson.featureFilter(me.featureCollection, p => p.zoom === zoom && p.ids && p.ids[0] === id),
                opacity: 1,
                visible: true
            });
        }
    }

    removeStationOutline(name) {
        for (const zoom of [13, 14, 15, 16, 17, 18]) {
            helpersMapbox.setLayerProps(this.map, `${name}-${zoom}`, {
                visible: false
            });
        }
    }

    refreshStationOutline() {
        const p = performance.now() % 1500 / 1500 * 2;

        for (const zoom of [13, 14, 15, 16, 17, 18]) {
            helpersMapbox.setLayerProps(this.map, `stations-selected-${zoom}`, {
                opacity: p < 1 ? p : 2 - p,
                visible: true
            });
        }
    }

    setSectionData(train, index, final) {
        const stations = train.r.stations,
            { direction, timetable } = train,
            destination = (train.ds || [])[0],
            delay = train.delay || 0,
            now = this.clock.getTimeOffset();
        let arrivalTimes, departureTimes, ttIndex, departureStation, arrivalStation, currentSection, nextSection, finalSection;

        if (timetable) {
            const s = timetable.stations;

            arrivalTimes = timetable.arrivalTimes;
            departureTimes = timetable.departureTimes;
            ttIndex = helpers.valueOrDefault(index, departureTimes.reduce(
                (acc, cur, i) => cur !== undefined && cur + delay <= now ? i : acc, 0
            ));
            departureStation = s[ttIndex];
            arrivalStation = s[ttIndex + 1];
        } else {
            departureStation = train.fs || train.ts;
            arrivalStation = train.ts || train.fs;
        }

        if (direction > 0) {
            currentSection = stations.indexOf(departureStation);
            nextSection = stations.indexOf(arrivalStation, currentSection);
            finalSection = stations.indexOf(destination, currentSection);
            if (finalSection === -1) {
                finalSection = stations.length - 1;
            }
        } else {
            currentSection = stations.lastIndexOf(departureStation);
            nextSection = stations.lastIndexOf(arrivalStation, currentSection);
            finalSection = stations.lastIndexOf(destination, currentSection);
            if (finalSection === -1) {
                finalSection = 0;
            }
        }

        if (timetable) {
            train.timetableIndex = ttIndex;
            train.departureStation = departureStation;
            train.departureTime = helpers.valueOrDefault(departureTimes[ttIndex], arrivalTimes[ttIndex]);

            if (currentSection >= 0 && nextSection >= 0) {
                train.sectionIndex = currentSection;
                train.sectionLength = nextSection - currentSection;
                train.arrivalStation = arrivalStation;
                train.arrivalTime = arrivalTimes[ttIndex + 1];
                train.nextDepartureTime = departureTimes[ttIndex + 1];

                return true;
            }

        } else {
            let actualSection;

            if (train.sectionIndex === undefined) {
                actualSection = nextSection = currentSection;
            } else {
                actualSection = train.sectionIndex + train.sectionLength;
            }

            train.departureStation = departureStation;

            if (actualSection >= 0 && actualSection !== finalSection && ((!final && nextSection >= 0) || (final && finalSection >= 0))) {
                train.sectionIndex = actualSection;
                train.sectionLength = (final ? finalSection : nextSection) - actualSection;
                train.arrivalStation = arrivalStation === departureStation ? stations[actualSection + direction] : arrivalStation;

                return true;
            }
        }

        train.arrivalStation = train.arrivalTime = undefined;
    }

    setBusSectionData(bus, index, final) {
        const stopSequences = bus.trip.stopSequences,
            now = this.clock.getTimeOffset();
        let departureTimes, currentSection;

        if (bus.stop === undefined) {
            departureTimes = bus.trip.departureTimes;
            currentSection = helpers.valueOrDefault(index, departureTimes.reduce(
                (acc, cur, i) => cur <= now ? i : acc, 0
            ));
        } else {
            currentSection = stopSequences.indexOf(bus.stop);
        }

        // Guard for an unexpected error
        // Potential data quality issue
        if (currentSection === -1) {
            console.log('no bus stop', bus);
        }

        const finalSection = stopSequences.length - 1;

        if (bus.stop === undefined) {
            if (currentSection !== finalSection) {
                bus.sectionIndex = currentSection;
                bus.sectionLength = 1;
                bus.departureTime = departureTimes[currentSection];
                bus.nextDepartureTime = departureTimes[currentSection + 1];

                return true;
            }
        } else {
            let actualSection, nextSection;

            if (bus.sectionIndex === undefined) {
                actualSection = nextSection = currentSection;
            } else {
                actualSection = bus.sectionIndex + bus.sectionLength;
                nextSection = Math.min(currentSection + 1, finalSection);
            }

            if (!final && actualSection !== finalSection) {
                bus.sectionIndex = actualSection;
                bus.sectionLength = nextSection - actualSection;

                return true;
            }
        }
    }
}

function initContainer(container) {
    const map = helpers.createElement('div', {
        id: 'map'
    }, container);

    helpers.createElement('div', {
        id: 'loader',
        className: 'loader-inner ball-pulse',
        innerHTML: '<div></div><div></div><div></div>'
    }, container);
    helpers.createElement('div', {
        id: 'loading-error'
    }, container);
    container.classList.add('mini-tokyo-3d');
    return map;
}

function showLoader(container) {
    const element = container.querySelector('#loader');

    element.style.opacity = 1;
    element.style.display = 'block';
}

function hideLoader(container) {
    const element = container.querySelector('#loader');

    element.style.opacity = 0;
    setTimeout(() => {
        element.style.display = 'none';
    }, 1000);
}

function showErrorMessage(container) {
    const loaderElement = container.querySelector('#loader'),
        errorElement = container.querySelector('#loading-error');

    loaderElement.style.display = 'none';
    errorElement.innerHTML = 'Loading failed. Please reload the page.';
    errorElement.style.display = 'block';
}

function easeInQuad(t) {
    return t * t;
}

function easeOutQuart(t) {
    return -((t -= 1) * t * t * t - 1);
}

function createInterpolant(xs, ys) {
    const length = xs.length;

    // Get consecutive differences and slopes
    const dys = [], dxs = [], ms = [];
    for (let i = 0; i < length - 1; i++) {
        const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i];
        dxs.push(dx); dys.push(dy); ms.push(dy / dx);
    }

    // Get degree-1 coefficients
    const c1s = [ms[0]];
    for (let i = 0; i < dxs.length - 1; i++) {
        const m = ms[i], mNext = ms[i + 1];
        if (m * mNext <= 0) {
            c1s.push(0);
        } else {
            const dx_ = dxs[i], dxNext = dxs[i + 1], common = dx_ + dxNext;
            c1s.push(3 * common / ((common + dxNext) / m + (common + dx_) / mNext));
        }
    }
    c1s.push(ms[ms.length - 1]);

    // Get degree-2 and degree-3 coefficients
    const c2s = [], c3s = [];
    for (let i = 0; i < c1s.length - 1; i++) {
        const c1 = c1s[i], m_ = ms[i], invDx = 1 / dxs[i], common_ = c1 + c1s[i + 1] - m_ - m_;
        c2s.push((m_ - c1 - common_) * invDx); c3s.push(common_ * invDx * invDx);
    }

    // Return interpolant function
    return x => {
        // The rightmost point in the dataset should give an exact result
        let i = xs.length - 1;
        if (x === xs[i]) {
            return ys[i];
        }

        // Search for the interval x is in, returning the corresponding y if x is one of the original xs
        let low = 0, mid, high = c3s.length - 1;
        while (low <= high) {
            mid = Math.floor(0.5 * (low + high));
            const xHere = xs[mid];
            if (xHere < x) {
                low = mid + 1;
            } else if (xHere > x) {
                high = mid - 1;
            } else {
                return ys[mid];
            }
        }
        i = Math.max(0, high);

        // Interpolate
        const diff = x - xs[i], diffSq = diff * diff;
        return ys[i] + c1s[i] * diff + c2s[i] * diffSq + c3s[i] * diff * diffSq;
    };
}

function getLayerZoom(zoom) {
    return helpers.clamp(Math.floor(zoom), 13, 18);
}

// Deprecated
// function getObjectScale(zoom) {
//     return Math.pow(2, 14 - helpers.clamp(zoom, 13, 19));
// }

function isVehicle(object) {
    return object && helpers.includes(['train', 'flight', 'bus'], object.type);
}

function isStation(object) {
    return object && object.type === 'station';
}

function isEqualObject(a, b) {
    if (a === b) {
        return true;
    }
    if (a && a.properties && b && b.properties && a.properties.ids === b.properties.ids) {
        return true;
    }
    return false;
}
