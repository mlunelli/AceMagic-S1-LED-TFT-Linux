'use strict';
/*!
 * s1panel - sensor/kodi
 * GPL-3 Licensed
 *
 * what kodi is playing, through its json-rpc over tcp (port 9090, enabled by
 * default for local connections). the player is polled once a second on one
 * long lived connection: cheaper than it sounds on localhost, and unlike the
 * notifications it can never miss a state change
 */
const net = require('net');

const logger = require('../logger');

const POLL_MS = 1000;
const RECONNECT_MS = 5000;
const REQUEST_TIMEOUT_MS = 3000;

// release tags that end the useful part of a file name
const RELEASE_TAGS = /\b(2160p|1080p|1080i|720p|576p|480p|4k|uhd|hdr|hdr10|dv|bluray|blu-ray|brrip|bdrip|web-?dl|webrip|web|hdtv|dvdrip|dvd|x264|x265|h264|h265|hevc|avc|aac|ac3|dts|remux|proper|repack|extended|multi|ita|eng|sub|subs)\b/i;

var _host = '127.0.0.1';
var _port = 9090;
var _show_paused = false;

var _socket = null;
var _connected = false;
var _stopped = false;
var _fault = false;
var _buffer = '';
var _next_id = 1;
var _pending = {};
var _poll_timer = null;
var _reconnect_timer = null;

// bumped by every connect and by stop. the gui restarts the sensor by stopping
// and starting it again, and the old socket only reports its close afterwards:
// anything from an older generation is ignored, or it would reconnect and poll
// alongside the new one
var _generation = 0;

var _state = empty_state();

function empty_state() {

    return { status: 'stopped', type: '', title: '', subtitle: '', time: 0, total: 0, percentage: 0 };
}

function to_seconds(time) {

    return time ? (time.hours || 0) * 3600 + (time.minutes || 0) * 60 + (time.seconds || 0) : 0;
}

function pad(n) {

    return n < 10 ? '0' + n : String(n);
}

function format_duration(seconds) {

    const _h = Math.floor(seconds / 3600);
    const _m = Math.floor((seconds % 3600) / 60);
    const _s = Math.floor(seconds % 60);

    return _h ? _h + ':' + pad(_m) + ':' + pad(_s) : _m + ':' + pad(_s);
}

/*
 * a file outside the library has no title, only its name, which for a typical
 * release reads Name.Of.The.Movie.2025.1080p.BluRay.x264-GROUP.mkv
 */
function clean_file_name(label) {

    var _name = String(label || '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
    var _year = '';

    // the year is the last one in the name: Blade Runner 2049 2017, 1917 2019
    const _years = [ ..._name.matchAll(/[\s(\[]((?:19|20)\d\d)(?=[\s)\]]|$)/g) ].filter(each => each.index > 0);
    const _year_match = _years[_years.length - 1];

    if (_year_match) {

        _year = _year_match[1];
        _name = _name.substring(0, _year_match.index);
    }

    const _tag = _name.match(RELEASE_TAGS);

    if (_tag && _tag.index > 0) {
        _name = _name.substring(0, _tag.index);
    }

    _name = _name.replace(/[\s\-\[(]+$/, '').replace(/\s+/g, ' ').trim();

    return { name: _name || String(label || ''), year: _year };
}

function describe_item(item) {

    if (!item) {
        return { title: '', subtitle: '' };
    }

    if ('episode' === item.type && item.showtitle) {

        const _number = item.season >= 0 && item.episode >= 0 ? 'S' + pad(item.season) + 'E' + pad(item.episode) : '';

        return { title: item.title || item.label, subtitle: [ item.showtitle, _number ].filter(each => each).join(' · ') };
    }

    if ('song' === item.type || (item.artist && item.artist.length)) {

        return { title: item.title || item.label, subtitle: [ (item.artist || []).join(', '), item.album ].filter(each => each).join(' · ') };
    }

    if (item.title) {

        return { title: item.title, subtitle: item.year ? 'Film · ' + item.year : 'Film' };
    }

    const _clean = clean_file_name(item.label || item.file);

    return { title: _clean.name, subtitle: _clean.year ? 'Video · ' + _clean.year : 'Video' };
}

function request(method, params) {

    return new Promise((fulfill, reject) => {

        if (!_connected) {
            return reject('not connected');
        }

        const _id = _next_id++;

        const _timer = setTimeout(() => {

            delete _pending[_id];
            reject(method + ' timed out');

        }, REQUEST_TIMEOUT_MS);

        _pending[_id] = { fulfill, reject, timer: _timer };

        _socket.write(JSON.stringify({ jsonrpc: '2.0', method: method, params: params || {}, id: _id }));
    });
}

function on_message(message) {

    // notifications have no id, the poll already covers what they announce
    const _waiting = undefined !== message.id ? _pending[message.id] : null;

    if (!_waiting) {
        return;
    }

    delete _pending[message.id];
    clearTimeout(_waiting.timer);

    if (message.error) {
        _waiting.reject(message.error.message || 'error');
    }
    else {
        _waiting.fulfill(message.result);
    }
}

/*
 * replies and notifications arrive back to back on the stream with no
 * separator, and a large one can be split, so objects are found by braces
 */
function parse_stream(chunk) {

    _buffer += chunk;

    var _depth = 0;
    var _start = -1;
    var _in_string = false;
    var _escape = false;
    var _consumed = 0;

    for (var i = 0; i < _buffer.length; i++) {

        const _char = _buffer[i];

        if (_in_string) {

            if (_escape) {
                _escape = false;
            }
            else if ('\\' === _char) {
                _escape = true;
            }
            else if ('"' === _char) {
                _in_string = false;
            }
            continue;
        }

        if ('"' === _char) {
            _in_string = true;
        }
        else if ('{' === _char) {

            if (!_depth) {
                _start = i;
            }
            _depth++;
        }
        else if ('}' === _char && _depth) {

            _depth--;

            if (!_depth) {

                try {
                    on_message(JSON.parse(_buffer.substring(_start, i + 1)));
                }
                catch (ex) {
                    logger.error('kodi: cannot parse json-rpc message: ' + ex.message);
                }

                _consumed = i + 1;
            }
        }
    }

    _buffer = _buffer.substring(_consumed);
}

function poll(generation) {

    if (generation !== _generation) {
        return;
    }

    _poll_timer = null;

    request('Player.GetActivePlayers').then(players => {

        // video wins over a picture slideshow or music playing behind it
        const _player = (players || []).find(each => 'video' === each.type) || (players || []).find(each => 'audio' === each.type);

        if (!_player) {

            _state = empty_state();
            return;
        }

        return Promise.all([

            request('Player.GetProperties', { playerid: _player.playerid, properties: [ 'time', 'totaltime', 'percentage', 'speed' ] }),
            request('Player.GetItem', { playerid: _player.playerid, properties: [ 'title', 'showtitle', 'season', 'episode', 'year', 'artist', 'album', 'file' ] })

        ]).then(results => {

            const _properties = results[0] || {};
            const _described = describe_item(results[1] ? results[1].item : null);

            _state = {
                status: _properties.speed ? 'playing' : 'paused',
                type: _player.type,
                title: _described.title,
                subtitle: _described.subtitle,
                time: to_seconds(_properties.time),
                total: to_seconds(_properties.totaltime),
                percentage: Number(_properties.percentage) || 0
            };
        });

    }).catch(err => {

        logger.error('kodi: ' + err);

    }).finally(() => {

        if (_connected && !_stopped && generation === _generation) {
            _poll_timer = setTimeout(() => poll(generation), POLL_MS);
        }
    });
}

function schedule_reconnect() {

    if (_stopped || _reconnect_timer) {
        return;
    }

    _reconnect_timer = setTimeout(() => {

        _reconnect_timer = null;
        connect();

    }, RECONNECT_MS);
}

function connect() {

    if (_stopped) {
        return;
    }

    const _generation_of_socket = ++_generation;
    const _mine = () => _generation_of_socket === _generation;

    _buffer = '';
    _socket = net.createConnection({ host: _host, port: _port });
    _socket.setEncoding('utf8');

    _socket.on('connect', () => {

        if (!_mine()) {
            return;
        }

        _connected = true;
        _fault = false;

        logger.info('kodi: connected to json-rpc on ' + _host + ':' + _port);

        poll(_generation_of_socket);
    });

    _socket.on('data', chunk => {

        if (_mine()) {
            parse_stream(chunk);
        }
    });

    _socket.on('error', err => {

        if (!_mine()) {
            return;
        }

        // kodi not started yet, or restarting: say it once, keep trying quietly
        if (!_fault) {

            logger.error('kodi: json-rpc on ' + _host + ':' + _port + ' not reachable (' + err.code + '), retrying every ' + (RECONNECT_MS / 1000) + 's');
            _fault = true;
        }
    });

    _socket.on('close', () => {

        if (!_mine()) {
            return;
        }

        _connected = false;
        _state = empty_state();

        Object.keys(_pending).forEach(id => {

            clearTimeout(_pending[id].timer);
            _pending[id].reject('connection closed');
        });

        _pending = {};

        if (_poll_timer) {

            clearTimeout(_poll_timer);
            _poll_timer = null;
        }

        schedule_reconnect();
    });
}

function end_time() {

    const _end = new Date(Date.now() + Math.max(0, _state.total - _state.time) * 1000);

    return _end.getHours() + ':' + pad(_end.getMinutes());
}

function sample(rate, format) {

    return new Promise(fulfill => {

        const _active = 'stopped' !== _state.status;

        const _output = format.replace(/{(\d+)}/g, function (match, number) {

            switch (number) {

                case '0':   // playing, paused, stopped
                    return _state.status;

                case '1':
                    return _state.title;

                case '2':   // series and episode, artist and album, or the year
                    return _state.subtitle;

                case '3':   // elapsed
                    return _active ? format_duration(_state.time) : '';

                case '4':   // total
                    return _active ? format_duration(_state.total) : '';

                case '5':   // remaining
                    return _active ? '-' + format_duration(Math.max(0, _state.total - _state.time)) : '';

                case '6':   // percentage, the 0..100 range is what a bar or gauge wants
                    return _state.percentage.toFixed(0);

                case '7':   // wall clock time the item ends at
                    return _active ? end_time() : '';

                case '8':   // video or audio
                    return _state.type;

                case '9':
                    return 'playing' === _state.status ? '▶' : ('paused' === _state.status ? '❚❚' : '■');

                default:
                    return 'null';
            }
        });

        fulfill({ value: _output, min: 0, max: 100 });
    });
}

/*
 * true while something is playing, and while paused too if show_paused is set.
 * a screen with show_when kodi is only in the rotation while this is true
 */
function active() {

    return 'playing' === _state.status || (_show_paused && 'paused' === _state.status);
}

function init(config) {

    _host = config?.host || '127.0.0.1';
    _port = Number(config?.port) || 9090;
    _show_paused = config?.show_paused ? true : false;

    _stopped = false;

    logger.info('initialize: kodi json-rpc at ' + _host + ':' + _port);

    connect();

    return 'kodi';
}

function stop() {

    _stopped = true;
    _connected = false;
    _generation++;

    Object.keys(_pending).forEach(id => {

        clearTimeout(_pending[id].timer);
        _pending[id].reject('sensor stopped');
    });

    _pending = {};
    _state = empty_state();

    [ _poll_timer, _reconnect_timer ].forEach(timer => timer && clearTimeout(timer));

    _poll_timer = null;
    _reconnect_timer = null;

    if (_socket) {
        _socket.destroy();
        _socket = null;
    }

    return Promise.resolve();
}

/* this will only be used for GUI configuration */

function settings() {
    return {
        name: 'kodi',
        description: 'what kodi is playing',
        icon: 'pi-play',
        multiple: false,
        ident: [],
        fields: [
            { name: 'host', type: 'string', value: '127.0.0.1' },
            { name: 'port', type: 'number', value: 9090 },
            { name: 'show_paused', type: 'boolean', value: false }    // keep show_when screens up while paused
        ]
    };
}

module.exports = {
    init,
    settings,
    sample,
    active,
    stop
};
