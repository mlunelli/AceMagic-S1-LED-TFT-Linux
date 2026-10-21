'use strict';
/*!
 * s1panel - sensor/nvme_temp
 * GPL-3 Licensed
 */
const fs = require('fs');
const path = require('path');

const logger = require('../logger');

const HWMON_PATH = '/sys/class/hwmon';

var _max_points = 10;
var _fahrenheit = false;
var _last_sampled = 0;
var _history = [];
var _max_temp = 0;
var _min_temp = 0;
var _source = null;
var _fault = false;

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

function to_unit(millidegrees) {

    const _celsius = Number(millidegrees) / 1000;

    return _fahrenheit ? _celsius * 9 / 5 + 32 : _celsius;
}

/*
 * hwmon numbering is not stable across boots, so look the chip up by name.
 * temp1 is the composite reading the drive itself reports as its temperature
 */
function find_source() {

    return new Promise(fulfill => {

        fs.readdir(HWMON_PATH, (err, entries) => {

            if (err) {
                return fulfill(null);
            }

            Promise.all(entries.map(each => {

                const _dir = path.join(HWMON_PATH, each);

                return read_file(path.join(_dir, 'name')).then(name => ({ name, dir: _dir }), () => ({}));

            })).then(chips => {

                const _chip = chips.find(each => 'nvme' === each.name);

                fulfill(_chip ? _chip.dir : null);
            });
        });
    });
}

function init_range(dir) {

    if (!_max_temp) {

        // the drive reports where it starts throttling (max) and where it shuts
        // down (crit), the gauge is more useful topping out at the first one
        read_file(path.join(dir, 'temp1_max')).catch(() => read_file(path.join(dir, 'temp1_crit'))).then(value => {

            _max_temp = Math.round(to_unit(value));

        }, () => {

            _max_temp = _fahrenheit ? 185 : 85;

        }).finally(() => {

            logger.info('initialize: nvme temp max set to ' + _max_temp);
        });
    }

    if (!_min_temp) {

        // temp1_min on these drives is a meaningless -0.15, use a room temperature floor
        _min_temp = _fahrenheit ? 68 : 20;

        logger.info('initialize: nvme temp min set to ' + _min_temp);
    }
}

function nvme_temp() {

    var _source_promise = Promise.resolve(_source);

    if (!_source) {

        _source_promise = find_source().then(dir => {

            if (dir) {

                _source = dir;

                logger.info('initialize: nvme temp is reading ' + dir);

                init_range(dir);
            }

            return dir;
        });
    }

    return _source_promise.then(dir => {

        if (!dir) {
            return Promise.reject('no nvme hwmon chip found');
        }

        return read_file(path.join(dir, 'temp1_input'));

    }).then(value => {

        return to_unit(value);

    }, err => {

        if (!_fault) {

            logger.error('nvme_temp: ' + err);
            _fault = true;
        }

        return null;
    });
}

function sample(rate, format) {

    return new Promise(fulfill => {

        const _diff = Math.floor(Number(process.hrtime.bigint()) / 1000000) - _last_sampled;
        var _dirty = false;
        var _temp_promise = Promise.resolve();

        if (!_last_sampled || _diff > rate) {

            _last_sampled = Math.floor(Number(process.hrtime.bigint()) / 1000000);

            _temp_promise = nvme_temp();
            _dirty = true;
        }

        _temp_promise.then(value => {

            if (!_history.length) {

                for (var i = 0; i < _max_points; i++) {
                    _history.push(0);
                }
            }

            if (null !== value && undefined !== value && _dirty) {

                _history.push(value.toFixed(0));
                _history.shift();
            }

            const _output = format.replace(/{(\d+)}/g, function (match, number) {

                switch (number) {

                    case '0':   // degrees
                        return _history[_history.length - 1];

                    case '1':   // history
                        return _history.join();

                    case '2':
                        return _fahrenheit ? 'F' : 'C';

                    default:
                        return 'null';
                }
            });

            fulfill({ value: _output, min: _min_temp, max: _max_temp });
        });
    });
}

function init(config) {

    if (config) {
        _max_points = config.max_points || 10;
        _fahrenheit = config.fahrenheit || false;
        _max_temp = config.max_temp || 0;
        _min_temp = config.min_temp || 0;
    }

    logger.info('initialize: nvme temp max points are set to ' + _max_points);

    return 'nvme_temp';
}

function stop() {
    return Promise.resolve();
}

/* this will only be used for GUI configuration */

function settings() {
    return {
        name: 'nvme_temp',
        description: 'nvme drive temp monitor',
        icon: 'pi-server',
        multiple: false,
        ident: [],
        fields: [
            { name: 'max_points', type: 'number', value: 300 },
            { name: 'fahrenheit', type: 'boolean', value: false },
            { name: 'max_temp', type: 'number', value: 0 },     // 0 picks the limit the drive reports
            { name: 'min_temp', type: 'number', value: 0 },
        ]
    };
}

module.exports = {
    init,
    settings,
    sample,
    stop
};
