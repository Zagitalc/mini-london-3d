import Panel from './panel';

export default class extends Panel {

    constructor(options) {
        super(Object.assign({
            className: 'layer-panel',
            modal: true
        }, options));
    }

    addTo(map) {
        const me = this,
            layers = me._options.layers || [],
            extraItems = me._options.extraItems || [];

        const rows = [
            ...layers.map(layer => [
                `<div id="${layer.getId()}-layer" class="layer-row">`,
                '<div class="layer-icon"></div>',
                `<div>${layer.getName(map.lang)}</div>`,
                '</div>'
            ].join('')),
            ...extraItems.map(item => [
                `<div id="${item.id}-layer" class="layer-row">`,
                '<div class="layer-icon"></div>',
                `<div>${item.title}</div>`,
                '</div>'
            ].join(''))
        ].join('');

        super.addTo(map)
            .setTitle(map.dict['layers'])
            .setHTML(rows);

        for (const layer of layers) {
            const element = me._container.querySelector(`#${layer.getId()}-layer .layer-icon`),
                classList = element.classList;

            Object.assign(element.style, layer.getIconStyle());
            if (layer.isEnabled()) {
                classList.add('layer-icon-enabled');
            }

            element.addEventListener('click', () => {
                if (layer.isEnabled()) {
                    classList.remove('layer-icon-enabled');
                    layer.disable();
                } else {
                    classList.add('layer-icon-enabled');
                    layer.enable();
                }
            });
        }

        for (const item of extraItems) {
            const element = me._container.querySelector(`#${item.id}-layer .layer-icon`);
            if (!element) continue;

            const classList = element.classList;
            const isEnabled = typeof item.enabled === 'function' ? item.enabled() : item.enabled;

            if (item.iconStyle) {
                Object.assign(element.style, item.iconStyle);
            }
            if (isEnabled) {
                classList.add('layer-icon-enabled');
            }

            element.addEventListener('click', () => {
                const nextEnabled = !classList.contains('layer-icon-enabled');
                classList.toggle('layer-icon-enabled', nextEnabled);
                if (item.onToggle) {
                    item.onToggle(nextEnabled, map);
                }
            });
        }

        return me;
    }

}
