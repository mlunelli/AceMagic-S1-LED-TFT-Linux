'use strict';
/*!
 * s1panel - widget/scroll_text
 * GPL-3 Licensed
 *
 * a text that does not fit its rect is shown a page at a time (default), or
 * scrolled to the left. the panel takes a few updates a second at best, so a
 * scroll always moves in visible steps; pages break between words instead and
 * only touch the usb bus when the page changes. timing comes from the clock so
 * it holds even if a poll is late
 */

const DEFAULT_MODE = 'page';
const DEFAULT_INTERVAL = 3000;  // ms each page stays up
const DEFAULT_SPEED = 40;       // scroll: pixels per second, 20px steps at the default poll
const DEFAULT_PAUSE = 2000;     // scroll: ms the text rests at the start of every lap
const DEFAULT_GAP = 40;         // scroll: pixels between the end of the text and the next lap

function get_hr_time() {

    return Math.floor(Number(process.hrtime.bigint()) / 1000000);
}

function number_or(value, fallback) {

    return undefined !== value && null !== value && '' !== value && !isNaN(Number(value)) ? Number(value) : fallback;
}

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

function align_offset(config, rect_width, text_width) {

    switch (config.align) {
        case 'center':
            return (rect_width / 2) - (text_width / 2);
        case 'right':
            return rect_width - text_width;
    }
    return 0;
}

/*
 * greedy word wrap into pages as wide as the rect. a single word wider than the
 * rect is cut by characters, there is no better place to break it
 */
function split_pages(context, text, width) {

    const _pages = [];
    var _line = '';

    const _push_word = word => {

        if (context.measureText(word).width <= width) {
            return word;
        }

        var _part = '';

        for (const _char of word) {

            if (_part && context.measureText(_part + _char).width > width) {

                _pages.push(_part);
                _part = '';
            }
            _part += _char;
        }
        return _part;
    };

    text.split(/\s+/).filter(each => each.length).forEach(word => {

        const _candidate = _line ? _line + ' ' + word : word;

        if (context.measureText(_candidate).width <= width) {

            _line = _candidate;
            return;
        }

        if (_line) {
            _pages.push(_line);
        }

        _line = _push_word(word);
    });

    if (_line) {
        _pages.push(_line);
    }

    return _pages.length ? _pages : [ '' ];
}

function draw_pages(context, _private, text, rect, config) {

    // measuring every word on every poll is wasted work, the pages only change
    // with the text, the font or the width
    const _layout = [ text, context.font, rect.width ].join('|');

    if (_private.layout !== _layout) {

        _private.layout = _layout;
        _private.pages = split_pages(context, text, rect.width);
    }

    const _interval = Math.max(500, number_or(config.interval, DEFAULT_INTERVAL));
    const _index = Math.floor((get_hr_time() - _private.started) / _interval) % _private.pages.length;
    const _page = _private.pages[_index];

    context.fillText(_page, rect.x + align_offset(config, rect.width, context.measureText(_page).width), rect.y);

    return text + '|' + _index;
}

function draw_scroll(context, _private, text, text_width, rect, config) {

    const _speed = number_or(config.speed, DEFAULT_SPEED) || DEFAULT_SPEED;
    const _pause = number_or(config.pause, DEFAULT_PAUSE);
    const _gap = number_or(config.gap, DEFAULT_GAP);

    const _lap_width = text_width + _gap;
    const _lap_time = _pause + (_lap_width / _speed) * 1000;

    const _elapsed = (get_hr_time() - _private.started) % _lap_time;

    // whole pixels, a fraction would only blur the glyphs on a 320x170 panel
    const _offset = _elapsed < _pause ? 0 : Math.floor(((_elapsed - _pause) / 1000) * _speed);

    // the next lap follows right behind, so the rect never runs empty
    context.fillText(text, rect.x - _offset, rect.y);
    context.fillText(text, rect.x - _offset + _lap_width, rect.y);

    return text + '|' + _offset;
}

function draw(context, value, min, max, config) {

    return new Promise(fulfill => {

        const _private = get_private(config);
        const _rect = config.rect;
        const _text = String(value);

        // a new text starts over from its first page or lap
        if (_private.last_value !== _text) {

            _private.last_value = _text;
            _private.started = get_hr_time();
        }

        start_draw(context, _rect);

        context.font = config.font || '20px Arial';
        context.fillStyle = config.color || 'white';
        context.textAlign = 'left';
        context.textBaseline = 'top';

        const _text_width = context.measureText(_text).width;
        var _key;

        if (_text_width <= _rect.width) {

            context.fillText(_text, _rect.x + align_offset(config, _rect.width, _text_width), _rect.y);

            _key = _text;
        }
        else if ('scroll' === (config.mode || DEFAULT_MODE)) {

            _key = draw_scroll(context, _private, _text, _text_width, _rect, config);
        }
        else {

            _key = draw_pages(context, _private, _text, _rect, config);
        }

        if (config.debug_frame) {
            debug_rect(context, _rect);
        }

        context.restore();

        // every page or step is a change, the region has to go to the panel again
        const _has_changed = _private.last_key !== _key ? true : false;

        _private.last_key = _key;

        fulfill(_has_changed);
    });
}

function info() {
    return {
        name: 'scroll_text',
        description: 'A formatted string shown in pages or scrolled when it does not fit',
        fields: [
            { name: 'font', value: 'font' },
            { name: 'color', value: 'color' },
            { name: 'align', value: 'list:left,center,right' },
            { name: 'mode', value: 'list:page,scroll' },
            { name: 'interval', value: 'number' },
            { name: 'speed', value: 'number' },
            { name: 'pause', value: 'number' },
            { name: 'gap', value: 'number' }
        ]
    };
}

module.exports = {
    info,
    draw
};
