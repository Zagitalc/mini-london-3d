import {GeoJsonLayer} from '@deck.gl/layers';
import {MapboxLayer} from '@deck.gl/mapbox';

export default class {

    constructor(implementation) {
        this.implementation = implementation;
    }

    onAdd(map, beforeId) {
        const me = this,
            implementation = me.implementation,
            id = implementation.id,
            options = Object.assign({}, implementation, {type: GeoJsonLayer}),
            mbox = map.map;

        me.map = map;

        delete options.minzoom;
        delete options.maxzoom;
        delete options.metadata;

        const fallbackId = beforeId && mbox.getLayer(beforeId) ? beforeId : (mbox.getLayer('poi') ? 'poi' : null);
        if (fallbackId) {
            mbox.addLayer(new MapboxLayer(options), fallbackId);
        } else {
            mbox.addLayer(new MapboxLayer(options));
        }
        mbox.setLayerZoomRange(id, implementation.minzoom, implementation.maxzoom);
        const layer = mbox.style && mbox.style.getOwnLayer(id);
        if (layer) {
            layer.metadata = implementation.metadata;
        }
    }

}
