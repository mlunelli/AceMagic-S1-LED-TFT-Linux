'use strict';
/*!
 * s1panel - widget/sparkline
 * GPL-3 Licensed
 *
 * a small history chart drawn straight on the canvas. line_chart renders through
 * chart.js and decodes a png on every poll; on this panel the cost that matters
 * is the usb one, so this only reports a change when the visible points move
 */

const DEFAULT_POINTS = 60;

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

function visible_points(value, count) {

    const _all = String(value).split(',').map(Number).filter(each => !isNaN(each));

    return _all.slice(Math.max(0, _all.length - count));
}

function value_range(points, min, max, config) {

    if ('auto' === config.scale) {

        const _lowest = Math.min(...points);
        const _highest = Math.max(...points);

        // a flat line would divide by zero, give it some room to sit in the middle
        return _highest === _lowest ? { low: _lowest - 1, high: _highest + 1 } : { low: _lowest, high: _highest };
    }

    const _low = Number(min) || 0;
    const _high = Number(max);

    return { low: _low, high: _high > _low ? _high : _low + 100 };
}

function draw(context, value, min, max, config) {

    return new Promise(fulfill => {

        const _private = get_private(config);
        const _rect = config.rect;
        const _points = visible_points(value, Math.max(2, Number(config.points) || DEFAULT_POINTS));

        start_draw(context, _rect);

        if (_points.length >= 2) {

            const _range = value_range(_points, min, max, config);
            const _line_width = Math.max(1, Number(config.line_width) || 1);

            // keep half the stroke inside the rect at the top and the bottom
            const _top = _rect.y + _line_width / 2;
            const _height = _rect.height - _line_width;
            const _step = _rect.width / (_points.length - 1);

            const _x = i => _rect.x + i * _step;
            const _y = v => _top + _height - (Math.min(Math.max(v, _range.low), _range.high) - _range.low) / (_range.high - _range.low) * _height;

            context.beginPath();
            context.moveTo(_x(0), _y(_points[0]));

            for (var i = 1; i < _points.length; i++) {
                context.lineTo(_x(i), _y(_points[i]));
            }

            if (config.fill) {

                context.save();
                context.lineTo(_x(_points.length - 1), _rect.y + _rect.height);
                context.lineTo(_x(0), _rect.y + _rect.height);
                context.closePath();
                context.fillStyle = config.fill;
                context.fill();
                context.restore();

                // the area closed the path, trace the line again on top of it
                context.beginPath();
                context.moveTo(_x(0), _y(_points[0]));

                for (var j = 1; j < _points.length; j++) {
                    context.lineTo(_x(j), _y(_points[j]));
                }
            }

            context.lineWidth = _line_width;
            context.lineJoin = 'round';
            context.strokeStyle = config.line || '#00e600';
            context.stroke();
        }

        if (config.debug_frame) {
            debug_rect(context, _rect);
        }

        context.restore();

        // the look of the chart, not just the data, so an edit from the gui shows up
        const _key = [ _points.join(), min, max, config.scale, config.line, config.fill, config.line_width ].join('|');
        const _has_changed = _private.last_key !== _key ? true : false;

        _private.last_key = _key;

        fulfill(_has_changed);
    });
}

function info() {
    return {
        name: 'sparkline',
        description: 'A small history chart, line or area',
        fields: [
            { name: 'line', value: 'color' },
            { name: 'fill', value: 'color' },
            { name: 'line_width', value: 'number' },
            { name: 'points', value: 'number' },
            { name: 'scale', value: 'list:sensor,auto' }
        ]
    };
}

module.exports = {
    info,
    draw
};
