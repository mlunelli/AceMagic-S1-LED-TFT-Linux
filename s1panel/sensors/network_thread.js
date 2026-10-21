'use strict';
/*!
 * s1panel - sensor/network_thread
 * Copyright (c) 2024-2025 Tomasz Jaworski
 * GPL-3 Licensed
 */
const fs       = require('fs');
const os       = require('os');
const threads  = require('worker_threads');
const logger   = require('../logger');

const DEFAULT_RATE_MS = 1000;
const TIMEOUT_COUNT = 30;
const DEFAULT_SPEED = 1000;
const DEFAULT_MTU = 1500;

var _running = false;
var _collect_count = 0;

var _timer = null;
var _fault = false;

function read_file(path, retry) {

    return new Promise((fulfill, reject) => {

        fs.readFile(path, 'utf8', (err, data) => {

            if (err) {

                if (!retry) {
                    // retry
                    return setTimeout(() => {

                        read_file(path, true).then(data2 => {

                            fulfill(data2);

                        }, err2 => {

                            reject(path + ': ' + err2);
                        });
        
                    }, 100);
                }
                
                return reject(path + ': ' + err);
            }
            
            fulfill(data);
        });
    });
}

function read_optional(path) {

    // bridges, wifi and interfaces that are down have no readable speed,
    // reading them must not take the whole collector down with it
    return new Promise(fulfill => {

        fs.readFile(path, 'utf8', (err, data) => {

            fulfill(err ? null : data);
        });
    });
}

function delta_per_second(current, last, elapsed) {

    if (null === last || elapsed <= 0) {
        return 0;
    }

    const _delta = current - last;

    // counters only go up, a negative delta means the counter was reset
    return _delta > 0 ? Math.round(_delta / elapsed) : 0;
}

function read_ip(iface) {

    return new Promise((fulfill, reject) => {

        const _nets = os.networkInterfaces();
        const _nic = _nets[iface];

        const _result = { ipv4: 'n/a', ipv6: 'n/a' };

        if (_nic) {

            const ipv4 = _nic.find(net => net.family === 'IPv4' && !net.internal);
            const ipv6 = _nic.find(net => net.family === 'IPv6' && !net.internal);
                
            if (ipv4 && ipv4.address) {
                _result.ipv4 = ipv4.address;
            }
            if (ipv6 && ipv6.address) {
                _result.ipv6 = ipv6.address;
            }
        }

        fulfill(_result);
    });
}

function network_usage(iface) {

    const _base_path = '/sys/class/net/' + iface;

    const _path = _base_path + '/statistics';

    return Promise.all([

        read_optional(_base_path + '/mtu'),
        read_optional(_base_path + '/speed'),

        read_file(_path + '/rx_bytes'),
        read_file(_path + '/tx_bytes'),

        read_file(_path + '/rx_packets'),
        read_file(_path + '/tx_packets'),

        read_ip(iface)
    ]);
}

var _last_rx_bytes = null;
var _last_tx_bytes = null;
var _last_rx_packets = null;
var _last_tx_packets = null;
var _last_time = 0;

function collect(message) {

    _collect_count++;

    if (_collect_count < TIMEOUT_COUNT) {

        return network_usage(message.iface).then(results => {
        
            const _link_mtu = Number(results[0]) || DEFAULT_MTU;
            const _speed = Number(results[1]);
            const _link_speed = _speed > 0 ? _speed : DEFAULT_SPEED;

            const _current_rx_bytes = Number(results[2]);
            const _current_tx_bytes = Number(results[3]);

            const _current_rx_packets = Number(results[4]);
            const _current_tx_packets = Number(results[5]);

            // the rates are per second, no matter what the sample rate is
            const _now = Math.floor(Number(process.hrtime.bigint()) / 1000000);
            const _elapsed = _last_time ? (_now - _last_time) / 1000 : 0;

            const _delta_rx_bytes = delta_per_second(_current_rx_bytes, _last_rx_bytes, _elapsed);
            const _delta_tx_bytes = delta_per_second(_current_tx_bytes, _last_tx_bytes, _elapsed);

            const _delta_rx_packets = delta_per_second(_current_rx_packets, _last_rx_packets, _elapsed);
            const _delta_tx_packets = delta_per_second(_current_tx_packets, _last_tx_packets, _elapsed);

            _last_rx_bytes = _current_rx_bytes;
            _last_tx_bytes = _current_tx_bytes;

            _last_rx_packets = _current_rx_packets;
            _last_tx_packets = _current_tx_packets;

            _last_time = _now;

            const _netf = results[6];   // ip address

            threads.parentPort.postMessage({
                mtu: _link_mtu,
                speed: _link_speed,
                rx: { bytes: _delta_rx_bytes, packets: _delta_rx_packets },
                tx: { bytes: _delta_tx_bytes, packets: _delta_tx_packets },
                ipv4: _netf ? _netf.ipv4 : 'n/a',
                ipv6: _netf ? _netf.ipv6 : 'n/a'
            });

            _timer = setTimeout(() => {

                collect(message);

            }, message.rate || DEFAULT_RATE_MS);

        }, err => {

            if (!_fault) {
                logger.error('network_thread: network stats read error for ' + message.iface + ': ' + err);
                _fault = true;
            }

            // transient errors must not stop the collector, the watchdog in
            // collect() still stops it when nobody asks for samples anymore
            _timer = setTimeout(() => {

                collect(message);

            }, message.rate || DEFAULT_RATE_MS);
        });
    }

    logger.info('network_thread: collector stopped for iface ' + message.iface);

    _running = false;
}

threads.parentPort.on('message', message => {

    _collect_count = 0; // reset

    if (message.stop) {

        logger.info('network_thread: requested to stop ' + threads.workerData.iface);
        
        // clear any outstanding timers...
        if (_timer) {
            clearTimeout(_timer);
        }

        // good bye
        return process.exit(0);
    }

    if (!_running) {

        _running = true;

        if (_fault) {
            logger.error('network_thread: restart after read error');
            _fault = false;
        }

        logger.info('network_thread: collector started for iface ' + message.iface);

        collect(message);
    }
});


logger.info('network_thread: started... for ' + threads.workerData.iface);
