'use strict';
/*!
 * s1panel - widget/progress_bar
 * GPL-3 Licensed
 *
 * a horizontal bar filled from the left, value between the sensor min and max.
 * it only counts as a change when the filled part moves a whole pixel: a two
 * hour movie on a 300px bar touches the usb bus about twice a minute
 */

function start_draw(context, rect) {
    context.save();
    context.beginPath();
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.clip();
}

function debug_rect(context, rect) {

    context.lineWidth = 1;
    context.strokeStyle = "red";
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.stroke();
}

function get_private(config) {

    if (!config._private) {
        config._private = {};
    }
    return config._private;
}

function rounded_rect(context, x, y, width, height, radius) {

    const _r = Math.max(0, Math.min(radius, width / 2, height / 2));

    context.beginPath();
    context.moveTo(x + _r, y);
    context.lineTo(x + width - _r, y);
    context.arcTo(x + width, y, x + width, y + _r, _r);
    context.lineTo(x + width, y + height - _r);
    context.arcTo(x + width, y + height, x + width - _r, y + height, _r);
    context.lineTo(x + _r, y + height);
    context.arcTo(x, y + height, x, y + height - _r, _r);
    context.lineTo(x, y + _r);
    context.arcTo(x, y, x + _r, y, _r);
    context.closePath();
}

function draw(context, value, min, max, config) {

    return new Promise(fulfill => {

        const _private = get_private(config);
        const _rect = config.rect;

        const _min = Number(min) || 0;
        const _max = Number(max);
        const _range = _max > _min ? _max - _min : 100;
        const _fraction = Math.min(Math.max((Number(value) - _min) / _range, 0), 1) || 0;

        const _filled = Math.round(_fraction * _rect.width);
        const _radius = Number(config.radius) || 0;

        start_draw(context, _rect);

        rounded_rect(context, _rect.x, _rect.y, _rect.width, _rect.height, _radius);
        context.fillStyle = config.background || '#4d4d4d';
        context.fill();

        if (_filled > 0) {

            // clip the fill to the rounded track, so a short bar keeps the left
            // corners and the right edge stays square until it reaches the end
            context.save();
            rounded_rect(context, _rect.x, _rect.y, _rect.width, _rect.height, _radius);
            context.clip();
            context.fillStyle = config.bar || '#00e600';
            context.fillRect(_rect.x, _rect.y, _filled, _rect.height);
            context.restore();
        }

        if (config.debug_frame) {
            debug_rect(context, _rect);
        }

        context.restore();

        // the look of the bar, not just the fill, so an edit from the gui shows up
        const _key = [ _filled, config.bar, config.background, _radius ].join('|');
        const _has_changed = _private.last_key !== _key ? true : false;

        _private.last_key = _key;

        fulfill(_has_changed);
    });
}

function info() {
    return {
        name: 'progress_bar',
        description: 'A horizontal progress bar',
        fields: [
            { name: 'bar', value: 'color' },
            { name: 'background', value: 'color' },
            { name: 'radius', value: 'number' }
        ]
    };
}

module.exports = {
    info,
    draw
};
