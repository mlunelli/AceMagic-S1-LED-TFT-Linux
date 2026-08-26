'use strict';
/*!
 * s1panel - widget/doughnut_chart
 * Copyright (c) 2024 Tomasz Jaworski
 * GPL-3 Licensed
 */
const logger = require('../logger');

const { loadImage }         = require('canvas');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

function debug_rect(context, rect) {

    context.lineWidth = 1;
    context.strokeStyle = "red";
    context.rect(rect.x, rect.y, rect.width, rect.height);
    context.stroke();
}

function draw_chart(context, x, y, chart, config) {

    return new Promise((fulfill, reject) => {

        chart.renderToBuffer(config).then(buffer => {
            
            loadImage(buffer).then(image => {

                context.drawImage(image, x, y);
        
                fulfill(image);

            }, reject);
        
        }, reject);
    });
}

function get_private(config) {

    if (!config._private) {
        config._private = {};
    }
    return config._private;
}

function draw(context, value, min, max, config) {

    return new Promise(fulfill => {

        const _private = get_private(config);
        const _rect = config.rect;

        // everything that changes what the gauge looks like, not just the value,
        // so a color or a range change from the gui invalidates the cache too
        const _key = [ value, min, max, config.used, config.free, config.rotation, config.cutout, config.circumference ].join('|');

        const _has_changed = (_private.last_key !== _key) ? true : false;

        context.save();
        context.beginPath();
        context.rect(_rect.x, _rect.y, _rect.width, _rect.height);
        context.clip();

        if (!_private.chart || _private.chart._width != _rect.width || _private.chart._height != _rect.height) {

            if (_private.chart) {
                delete _private.chart;
            }
            _private.last_image = null;
            _private.chart = new ChartJSNodeCanvas({ width: _rect.width, height: _rect.height });
        }

        // the canvas is wiped on every pass so the gauge has to be painted again even
        // when nothing moved, repainting the last image is far cheaper than asking
        // chart.js for the same picture over and over
        if (!_has_changed && _private.last_image) {

            context.drawImage(_private.last_image, _rect.x, _rect.y);

            if (config.debug_frame) {
                debug_rect(context, _rect);
            }

            context.restore();

            return fulfill(false);
        }

        // the gauge fill is proportional to the sum of the segments, so the
        // second segment has to be what is left of the range, not the maximum
        const _min = Number(min) || 0;
        const _max = Number(max);
        const _range = _max - _min;
        const _used = _range > 0 ? Math.min(Math.max(Number(value) - _min, 0), _range) : 0;

        const _points = [ _used, _range > 0 ? _range - _used : 1 ];
        const _labels = [ 'used', 'unused '];

        const _configuration = {
            type: 'doughnut',
            data: {
                labels: _labels,
                datasets: [{
                    label           : '',
                    data            : _points,
                    backgroundColor : [(config.used || '#48BB78'), (config.free || '#EDF2F7')],
                    borderColor     : config.free,
                    rotation        : config.rotation || 225,
                    cutout          : config.cutout || '80%',
                    circumference   : config.circumference || 270,
                }]
            },
            options: {
                plugins: {
                    legend: {
                      display: false
                    }
                },
                responsive: true,
                layout: { 
                    padding: { 
                        bottom: 0,
                        top: 0
                    } 
                },               
                legend: {
                    display: false
                }
            }
        };

        draw_chart(context, _rect.x, _rect.y, _private.chart, _configuration).then(image => {

            _private.last_image = image;
            _private.last_key = _key;

            if (config.debug_frame) {
                debug_rect(context, _rect);
            }

            context.restore();

        }, () => {

            logger.error('dougnut_chart draw failed');

            // without this the clip stays on the context and every widget
            // drawn after this one gets clipped away
            context.restore();

        }).finally(() => {

            fulfill(_has_changed);
        });       
    }); 
}

function info() {
    return {
        name: 'doughnut_chart',
        description: 'A daughnut chart',
        fields: [ 
            { name: 'used', value: 'color'}, 
            { name: 'free', value: 'color' }, 
            { name: 'rotation', value: 'string' }, 
            { name: 'cutout', value: 'string' }, 
            { name: 'circumference', value: 'string' } ]
    };
}

module.exports = {
    info,
    draw
};