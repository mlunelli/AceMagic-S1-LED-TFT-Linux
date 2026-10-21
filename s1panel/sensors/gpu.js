'use strict';
/*!
 * s1panel - sensor/gpu
 * GPL-3 Licensed
 *
 * intel gpu load from intel_gpu_top, which needs root (the service runs as root).
 * when it is missing or cannot run, only the frequency is read from sysfs
 */
const fs = require('fs');
const child_process = require('child_process');

const logger = require('../logger');

const DRM_PATH = '/sys/class/drm';
const RESTART_DELAY_MS = 10000;
const ENGINES = [ 'Render/3D', 'Video', 'VideoEnhance', 'Blitter' ];

var _max_points = 10;
var _interval = 1000;
var _card = null;
var _max_freq = 0;

var _child = null;
var _stopped = false;
var _use_sysfs = false;
var _restart_timer = null;
var _buffer = '';

var _last_sampled = 0;
var _current = { busy: 0, engines: {}, freq: 0, power: 0 };
var _history = [];
var _history_video = [];

function read_file(filename) {

    return new Promise((fulfill, reject) => {

        fs.readFile(filename, 'utf8', (err, data) => {

            if (err) {
                return reject(err);
            }

            fulfill(data.trim());
        });
    });
}

function record_sample(array, value) {

    if (!array.length) {

        for (var i = 0; i < _max_points; i++) {
            array.push(0);
        }
    }

    array.push(value);
    array.shift();
}

function find_card() {

    // the first card with gt frequency files is the intel one
    try {

        return fs.readdirSync(DRM_PATH).filter(each => /^card\d+$/.test(each)).map(each => DRM_PATH + '/' + each).find(each => fs.existsSync(each + '/gt_max_freq_mhz')) || null;
    }
    catch (ex) {

        return null;
    }
}

function on_reading(json) {

    const _engines = {};
    var _busy = 0;

    ENGINES.forEach(name => {

        const _engine = json.engines ? json.engines[name] : null;
        const _value = _engine ? Number(_engine.busy) || 0 : 0;

        _engines[name] = _value;
        _busy = Math.max(_busy, _value);
    });

    _current = {
        busy: _busy,
        engines: _engines,
        freq: json.frequency ? Number(json.frequency.actual) || 0 : 0,
        power: json.power ? Number(json.power.GPU) || 0 : 0
    };

    record_sample(_history, _busy.toFixed(0));
    record_sample(_history_video, _engines['Video'].toFixed(0));
}

/*
 * the output is a stream of top level objects separated by commas, flushed in 4k
 * blocks that cut objects anywhere, so objects are found by counting braces
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
                    on_reading(JSON.parse(_buffer.substring(_start, i + 1)));
                }
                catch (ex) {
                    logger.error('gpu: cannot parse intel_gpu_top output: ' + ex.message);
                }

                _consumed = i + 1;
            }
        }
    }

    _buffer = _buffer.substring(_consumed);
}

function start_gpu_top() {

    if (_stopped) {
        return;
    }

    _buffer = '';

    _child = child_process.spawn('intel_gpu_top', [ '-J', '-s', String(_interval), '-o', '-' ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });

    var _stderr = '';

    _child.stdout.setEncoding('utf8');
    _child.stdout.on('data', parse_stream);

    _child.stderr.setEncoding('utf8');
    _child.stderr.on('data', data => {

        _stderr = (_stderr + data).slice(-500);
    });

    _child.on('error', err => {

        // not installed: nothing to restart, fall back for good
        if ('ENOENT' === err.code) {

            logger.error('gpu: intel_gpu_top not found, only the frequency will be reported');
            _use_sysfs = true;
        }
        else {
            logger.error('gpu: intel_gpu_top failed: ' + err.message);
        }
    });

    _child.on('exit', (code, signal) => {

        _child = null;

        if (_stopped || _use_sysfs) {
            return;
        }

        logger.error('gpu: intel_gpu_top exited (' + (signal || code) + ')' + (_stderr ? ': ' + _stderr.trim() : '') + ', restarting in ' + (RESTART_DELAY_MS / 1000) + 's');

        // without root it fails right away, keep the frequency coming meanwhile
        _use_sysfs = true;

        _restart_timer = setTimeout(() => {

            _restart_timer = null;
            _use_sysfs = false;

            start_gpu_top();

        }, RESTART_DELAY_MS);
    });
}

function sample_sysfs() {

    if (!_card) {
        return Promise.resolve();
    }

    return read_file(_card + '/gt_act_freq_mhz').then(value => {

        _current.freq = Number(value) || 0;

        // no load figure without intel_gpu_top, the frequency is the closest thing
        const _load = _max_freq ? (_current.freq / _max_freq) * 100 : 0;

        _current.busy = _load;

        record_sample(_history, _load.toFixed(0));
        record_sample(_history_video, 0);

    }, () => {});
}

function sample(rate, format) {

    return new Promise(fulfill => {

        const _diff = Math.floor(Number(process.hrtime.bigint()) / 1000000) - _last_sampled;
        var _promise = Promise.resolve();

        if (_use_sysfs && (!_last_sampled || _diff > rate)) {

            _last_sampled = Math.floor(Number(process.hrtime.bigint()) / 1000000);
            _promise = sample_sysfs();
        }

        _promise.then(() => {

            if (!_history.length) {
                record_sample(_history, 0);
                record_sample(_history_video, 0);
            }

            var _max = 100;

            const _output = format.replace(/{(\d+)}/g, function (match, number) {

                switch (number) {

                    case '0':   // overall load, the busiest engine
                        return _current.busy.toFixed(0);

                    case '1':
                        return (_current.engines['Render/3D'] || 0).toFixed(0);
                    case '2':   // hardware video decode
                        return (_current.engines['Video'] || 0).toFixed(0);
                    case '3':
                        return (_current.engines['VideoEnhance'] || 0).toFixed(0);
                    case '4':
                        return (_current.engines['Blitter'] || 0).toFixed(0);

                    case '5':   // MHz, 0 while the gpu sleeps
                        _max = _max_freq || 100;
                        return _current.freq.toFixed(0);
                    case '6':
                        return _max_freq;

                    case '7':   // watts, not every gpu reports it
                        return _current.power.toFixed(1);

                    case '8':
                        return _history.join();
                    case '9':
                        return _history_video.join();

                    default:
                        return 'null';
                }
            });

            fulfill({ value: _output, min: 0, max: _max });
        });
    });
}

function init(config) {

    if (config) {
        _max_points = config.max_points || 10;
        _interval = config.interval || 1000;
    }

    _card = find_card();

    if (_card) {

        try {
            _max_freq = Number(fs.readFileSync(_card + '/gt_max_freq_mhz', 'utf8')) || 0;
        }
        catch (ex) {
            _max_freq = 0;
        }
    }

    logger.info('initialize: gpu is ' + (_card || 'not found') + ', max frequency ' + _max_freq + ' MHz');
    logger.info('initialize: gpu max points are set to ' + _max_points);

    _stopped = false;

    start_gpu_top();

    return 'gpu';
}

function stop() {

    _stopped = true;

    if (_restart_timer) {

        clearTimeout(_restart_timer);
        _restart_timer = null;
    }

    if (!_child) {
        return Promise.resolve();
    }

    return new Promise(fulfill => {

        _child.once('exit', () => fulfill());
        _child.kill();
    });
}

/* this will only be used for GUI configuration */

function settings() {
    return {
        name: 'gpu',
        description: 'intel gpu load monitor',
        icon: 'pi-desktop',
        multiple: false,
        ident: [],
        fields: [
            { name: 'max_points', type: 'number', value: 300 },
            { name: 'interval', type: 'number', value: 1000 },     // intel_gpu_top sampling period, ms
        ]
    };
}

module.exports = {
    init,
    settings,
    sample,
    stop
};
