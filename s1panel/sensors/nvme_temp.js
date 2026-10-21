'use strict';
/*!
 * s1panel - sensor/nvme_temp
 * GPL-3 Licensed
 */
const fs = require('fs');
const path = require('path');

const logger = require('../logger');

const HWMON_PATH = '/sys/class/hwmon';
const DEFAULT_DEVICE = 'nvme0';

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

function to_unit(_private, millidegrees) {

    const _celsius = Number(millidegrees) / 1000;

    return _private.fahrenheit ? _celsius * 9 / 5 + 32 : _celsius;
}

/*
 * hwmon numbering is not stable across boots and every drive is called nvme,
 * so the chip is found through its device link, which points at nvme0, nvme1...
 * temp1 is the composite reading the drive itself reports as its temperature
 */
function find_source(device) {

    return new Promise(fulfill => {

        fs.readdir(HWMON_PATH, (err, entries) => {

            if (err) {
                return fulfill(null);
            }

            Promise.all(entries.map(each => {

                const _dir = path.join(HWMON_PATH, each);

                return new Promise(done => {

                    fs.realpath(path.join(_dir, 'device'), (err2, target) => {

                        done({ dir: _dir, device: err2 ? null : path.basename(target) });
                    });
                });

            })).then(chips => {

                const _chip = chips.find(each => device === each.device);

                fulfill(_chip ? _chip.dir : null);
            });
        });
    });
}

function init_range(_private, dir) {

    if (!_private.max_temp) {

        // the drive reports where it starts throttling (max) and where it shuts
        // down (crit), the gauge is more useful topping out at the first one
        read_file(path.join(dir, 'temp1_max')).catch(() => read_file(path.join(dir, 'temp1_crit'))).then(value => {

            _private.max_temp = Math.round(to_unit(_private, value));

        }, () => {

            _private.max_temp = _private.fahrenheit ? 185 : 85;

        }).finally(() => {

            logger.info('initialize: nvme temp ' + _private.device + ' max set to ' + _private.max_temp);
        });
    }

    if (!_private.min_temp) {

        // temp1_min on these drives is a meaningless -0.15, use a room temperature floor
        _private.min_temp = _private.fahrenheit ? 68 : 20;

        logger.info('initialize: nvme temp ' + _private.device + ' min set to ' + _private.min_temp);
    }
}

function nvme_temp(_private) {

    var _source_promise = Promise.resolve(_private.source);

    if (!_private.source) {

        _source_promise = find_source(_private.device).then(dir => {

            if (dir) {

                _private.source = dir;

                logger.info('initialize: nvme temp ' + _private.device + ' is reading ' + dir);

                init_range(_private, dir);
            }

            return dir;
        });
    }

    return _source_promise.then(dir => {

        if (!dir) {
            return Promise.reject('no hwmon chip found for ' + _private.device);
        }

        return read_file(path.join(dir, 'temp1_input'));

    }).then(value => {

        return to_unit(_private, value);

    }, err => {

        if (!_private.fault) {

            logger.error('nvme_temp: ' + err);
            _private.fault = true;
        }

        return null;
    });
}

function sample(rate, format, config) {

    return new Promise(fulfill => {

        const _private = config._private;

        const _diff = Math.floor(Number(process.hrtime.bigint()) / 1000000) - _private.last_sampled;
        var _dirty = false;
        var _temp_promise = Promise.resolve();

        if (!_private.last_sampled || _diff > rate) {

            _private.last_sampled = Math.floor(Number(process.hrtime.bigint()) / 1000000);

            _temp_promise = nvme_temp(_private);
            _dirty = true;
        }

        _temp_promise.then(value => {

            const _history = _private.history;

            if (!_history.length) {

                for (var i = 0; i < _private.max_points; i++) {
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
                        return _private.fahrenheit ? 'F' : 'C';

                    case '3':   // device
                        return _private.device;

                    default:
                        return 'null';
                }
            });

            fulfill({ value: _output, min: _private.min_temp, max: _private.max_temp });
        });
    });
}

function init(config) {

    const _device = config?.device || DEFAULT_DEVICE;

    const _private = {
        name: config?.name || _device,
        device: _device,
        max_points: config?.max_points || 10,
        fahrenheit: config?.fahrenheit || false,
        max_temp: config?.max_temp || 0,
        min_temp: config?.min_temp || 0,
        last_sampled: 0,
        history: [],
        source: null,
        fault: false
    };

    logger.info('initialize: nvme temp for ' + _private.device + ', max points are set to ' + _private.max_points);

    config._private = _private;

    return 'nvme_temp_' + _private.name;
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
        multiple: true,
        ident: [ 'name', 'device' ],    // which fields will change the identity of the sensor
        fields: [
            { name: 'name', type: 'string', value: 'nvme0' },
            { name: 'device', type: 'string', value: 'nvme0' },    // as listed in /sys/class/nvme
            { name: 'max_points', type: 'number', value: 300 },
            { name: 'fahrenheit', type: 'boolean', value: false },
            { name: 'max_temp', type: 'number', value: 0 },        // 0 picks the limit the drive reports
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
