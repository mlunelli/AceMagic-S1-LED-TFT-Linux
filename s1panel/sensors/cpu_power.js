'use strict';
/*!
 * s1panel - sensor/power
 * Copyright (c) 2024 Tomasz Jaworski
 * GPL-3 Licensed
 */
const fs = require('fs');

const logger = require('../logger');

const BASE_DIR = '/sys/class/powercap/';

var _fault = false;
var _previous = null;

var _max_points = 10;
var _max_watts = 28;
var _last_sampled = 0;
var _history = [];

var _zones = null;

function read_file(path) {
  
    return new Promise(fulfill => {

        fs.readFile(path, 'utf8', (err, data) => {
            
            fulfill(err ? null : data);
        });
    });
}

function unique_packages(zones) {

    // the same package is often exposed twice, by msr (intel-rapl:0) and by
    // mmio (intel-rapl-mmio:0), keep the msr one so it is not counted twice
    const _unique = new Map();

    zones.forEach(each => {

        const _existing = _unique.get(each.name);

        if (!_existing || (_existing.mmio && !each.mmio)) {
            _unique.set(each.name, each);
        }
    });

    return Array.from(_unique.values());
}

function discover_zones() {

    return new Promise(fulfill => {

        fs.readdir(BASE_DIR, (err, dir) => {

            if (err) {

                if (!_fault) {
                    logger.error('cpu_power: ' + BASE_DIR + ' directory error: ' + err);
                    _fault = true;
                }
                return fulfill([]);
            }

            const _promises = dir.map(each => {

                const _path = BASE_DIR + each;

                return Promise.all([

                    read_file(_path + '/energy_uj'),
                    read_file(_path + '/name'),
                    read_file(_path + '/max_energy_range_uj')

                ]).then(results => {

                    if (null === results[0]) {
                        return null;    // not an energy zone, or not readable
                    }

                    return {
                        dir   : each,
                        path  : _path + '/energy_uj',
                        name  : (results[1] || each).trim(),
                        range : Number(results[2]) || 0,
                        mmio  : each.indexOf('-mmio') > -1,
                        depth : each.split(':').length - 1
                    };
                });
            });

            Promise.all(_promises).then(results => {

                const _found = results.filter(each => each);

                // rapl zones are hierarchical, a package already accounts for its
                // own sub zones (core, uncore, dram), adding them all up would
                // count the same energy two or three times
                var _packages = _found.filter(each => 0 === each.name.indexOf('package'));

                if (!_packages.length) {

                    // no package zone by name, fall back to the top level zones
                    _packages = _found.filter(each => 1 === each.depth);
                }

                fulfill(unique_packages(_packages));
            });
        });
    });
}

function get_zones() {

    if (_zones) {
        return Promise.resolve(_zones);
    }

    return discover_zones().then(zones => {

        _zones = zones;

        if (zones.length) {
            logger.info('initialize: cpu power is reading ' + zones.map(each => each.name + ' (' + each.dir + ')').join(', '));
        }
        else if (!_fault) {
            logger.error('cpu_power: no readable rapl package zone found in ' + BASE_DIR + ', power will stay at 0');
            _fault = true;
        }

        return zones;
    });
}

function power_usage() {

    return new Promise(fulfill => {

        get_zones().then(zones => {

            if (!zones.length) {
                return fulfill();
            }

            Promise.all(zones.map(each => read_file(each.path))).then(results => {

                const _response = { watts: 0.00 };
                const _current = {};

                var _joules = 0.0;

                zones.forEach((zone, index) => {

                    const _raw = results[index];

                    if (null === _raw) {
                        return;
                    }

                    const _value = Number(_raw);

                    _current[zone.dir] = _value;

                    if (!_previous) {
                        return;
                    }

                    const _prev = _previous[zone.dir];

                    if (undefined === _prev) {
                        return;
                    }

                    var _delta = _value - _prev;

                    if (_delta < 0) {

                        // the counter either wrapped around at max_energy_range_uj or it
                        // was reset (driver reload, resume from suspend). a real wrap can
                        // only happen when the previous reading was close to the top and
                        // it leaves a small delta behind, anything else is a reset and is
                        // skipped instead of reported as a huge spike
                        const _wrapped = zone.range ? (zone.range - _prev) + _value : 0;

                        _delta = (_prev > zone.range * 0.9 && _wrapped < zone.range * 0.01) ? _wrapped : 0;
                    }

                    _joules += _delta / 1000000;
                });

                _response.watts = _joules;
                _previous = _current;

                fulfill(_response);
            });
        });
    });
}

function sample(rate, format) {

    return new Promise(fulfill => {

        const _diff = Math.floor(Number(process.hrtime.bigint()) / 1000000) - _last_sampled;
        var _dirty = false;
        var _cpu_promise = Promise.resolve();

        if (!_last_sampled || _diff > rate) {

            _last_sampled = Math.floor(Number(process.hrtime.bigint()) / 1000000);
            _cpu_promise = power_usage();
            _dirty = true;
        }

        _cpu_promise.then(result => {

            if (result && _dirty) {
                
                var _seconds = _diff / 1000;

                if (!_history.length) {

                    for (var i = 0; i < _max_points; i++) {
                        _history.push(0);
                    }
                } 

                // joules over the elapsed interval, always normalized to watts
                if (_seconds > 0) {
                    result.watts = result.watts / _seconds;
                }

                // keep the raw reading, the format tokens do the rounding
                _history.push(Number(result.watts.toFixed(2)));
                _history.shift();
            }

            const _output = format.replace(/{(\d+)}/g, function (match, number) { 
        
                switch (number) {

                    case '0':
                        return Math.round(_history[_history.length - 1]);

                    case '1':
                        return _history.join();

                    case '2':   // one decimal, idle values are small
                        return Number(_history[_history.length - 1]).toFixed(1);
                        
                    default:
                        return 'null';
                }
            }); 

            fulfill({ value: _output, min: 0, max: _max_watts });
        });
    });
}

function init(config) {
    
    if (config) {
        _max_points = config.max_points || 10;
        _max_watts = config.max_watts || 28;
    }

    logger.info('initialize: cpu power max points are set to ' + _max_points);
    logger.info('initialize: cpu power gauge max is set to ' + _max_watts + 'W');
    
    return 'cpu_power';
}


module.exports = {
    init,
    sample
};
