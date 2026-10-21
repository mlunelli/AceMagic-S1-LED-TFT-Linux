'use strict';
/*!
 * s1panel - widget/needle_gauge
 * GPL-3 Licensed
 *
 * a dial with a needle, drawn straight on the canvas. the sweep is a half circle
 * (180, sitting on the bottom edge of the rect, 100x55 makes a 100 wide gauge)
 * or 270 degrees open at the bottom like the doughnut gauges. the needle only
 * counts as a change when it moves a whole degree, small jitter in a sensor
 * would otherwise send the region to the panel on every poll
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

function number_or(value, fallback) {

    return undefined !== value && null !== value && '' !== value && !isNaN(Number(value)) ? Number(value) : fallback;
}

/*
 * canvas angles grow clockwise with 1.5pi straight up, the sweep is centered on
 * it: 180 runs from pi (left) to 2pi (right), 270 from 0.75pi to 2.25pi
 */
function make_dial(sweep) {

    const _sweep = (270 === sweep ? 270 : 180) * Math.PI / 180;
    const _start = 1.5 * Math.PI - _sweep / 2;

    return { degrees: 270 === sweep ? 270 : 180, angle: fraction => _start + fraction * _sweep };
}

function draw_band(context, dial, cx, cy, radius, width, from, to, color) {

    if (to <= from) {
        return;
    }

    context.beginPath();
    context.arc(cx, cy, radius, dial.angle(from), dial.angle(to));
    context.lineWidth = width;
    context.strokeStyle = color;
    context.stroke();
}

function draw(context, value, min, max, config) {

    return new Promise(fulfill => {

        const _private = get_private(config);
        const _rect = config.rect;

        const _min = Number(min) || 0;
        const _max = Number(max);
        const _range = _max > _min ? _max - _min : 100;
        const _fraction = Math.min(Math.max((Number(value) - _min) / _range, 0), 1) || 0;

        const _dial = make_dial(number_or(config.sweep, 180));

        // a whole degree is about the finest step the needle shows at this size
        const _degrees = Math.round(_fraction * _dial.degrees);

        const _arc_width = Math.max(1, number_or(config.arc_width, 8));
        const _needle_color = config.needle || '#ffffff';
        const _ticks = Math.max(0, Math.floor(number_or(config.ticks, 5)));
        const _warn = number_or(config.warn, 0) / 100;
        const _danger = number_or(config.danger, 0) / 100;

        const _hub = 4;
        const _cx = _rect.x + _rect.width / 2;
        var _cy, _radius;

        if (270 === _dial.degrees) {

            // the open ends hang below the center by sin(45) of the radius
            _radius = Math.min(_rect.width / 2 - _arc_width / 2 - 1, (_rect.height - _arc_width - 2) / (1 + Math.SQRT1_2));
            _cy = _rect.y + 1 + _arc_width / 2 + _radius;
        }
        else {

            _radius = Math.min(_rect.width / 2, _rect.height - _hub) - _arc_width / 2 - 1;
            _cy = _rect.y + _rect.height - _hub;
        }

        _radius = Math.max(4, _radius);

        start_draw(context, _rect);

        context.lineCap = 'butt';

        // the dial, then the warning and danger bands painted over its end
        draw_band(context, _dial, _cx, _cy, _radius, _arc_width, 0, 1, config.arc || '#4d4d4d');

        if (_warn > 0) {
            draw_band(context, _dial, _cx, _cy, _radius, _arc_width, _warn, _danger > _warn ? _danger : 1, config.warn_color || '#e6c200');
        }

        if (_danger > 0) {
            draw_band(context, _dial, _cx, _cy, _radius, _arc_width, _danger, 1, config.danger_color || '#e60000');
        }

        // ticks just inside the dial, evenly from one end to the other
        if (_ticks > 1) {

            context.lineWidth = 1;
            context.strokeStyle = _needle_color;

            for (var i = 0; i < _ticks; i++) {

                const _angle = _dial.angle(i / (_ticks - 1));
                const _outer = _radius - _arc_width / 2 - 1;
                const _inner = _outer - Math.max(3, _arc_width / 2);

                context.beginPath();
                context.moveTo(_cx + Math.cos(_angle) * _inner, _cy + Math.sin(_angle) * _inner);
                context.lineTo(_cx + Math.cos(_angle) * _outer, _cy + Math.sin(_angle) * _outer);
                context.stroke();
            }
        }

        // the needle and its hub
        const _needle_angle = _dial.angle(_degrees / _dial.degrees);
        const _length = _radius - _arc_width / 2 - 2;

        context.beginPath();
        context.moveTo(_cx, _cy);
        context.lineTo(_cx + Math.cos(_needle_angle) * _length, _cy + Math.sin(_needle_angle) * _length);
        context.lineWidth = 3;
        context.lineCap = 'round';
        context.strokeStyle = _needle_color;
        context.stroke();

        context.beginPath();
        context.arc(_cx, _cy, _hub, 0, 2 * Math.PI);
        context.fillStyle = _needle_color;
        context.fill();

        if (config.debug_frame) {
            debug_rect(context, _rect);
        }

        context.restore();

        // the look of the dial, not just the needle, so an edit from the gui shows up
        const _key = [ _degrees, _dial.degrees, config.arc, _arc_width, _needle_color, _ticks, _warn, _danger, config.warn_color, config.danger_color ].join('|');
        const _has_changed = _private.last_key !== _key ? true : false;

        _private.last_key = _key;

        fulfill(_has_changed);
    });
}

function info() {
    return {
        name: 'needle_gauge',
        description: 'A half circle dial with a needle',
        fields: [
            { name: 'sweep', value: 'list:180,270' },
            { name: 'arc', value: 'color' },
            { name: 'arc_width', value: 'number' },
            { name: 'needle', value: 'color' },
            { name: 'ticks', value: 'number' },
            { name: 'warn', value: 'number' },          // % of the range where the warning band starts, 0 = none
            { name: 'danger', value: 'number' },        // % of the range where the danger band starts, 0 = none
            { name: 'warn_color', value: 'color' },
            { name: 'danger_color', value: 'color' }
        ]
    };
}

module.exports = {
    info,
    draw
};
