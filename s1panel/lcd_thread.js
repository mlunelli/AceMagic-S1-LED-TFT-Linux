'use strict';
/*!
 * s1panel - lcd_thread
 * Copyright (c) 2024 Tomasz Jaworski
 * GPL-3 Licensed
 */
const threads     = require('worker_threads');
const node_hid    = require('node-hid');
const lcd         = require('./lcd_device');
const logger      = require('./logger');

const usb_hid     = node_hid.HIDAsync;

const START_COOL_DOWN = 1000;
const POLL_TIMEOUT = 10;
const STATS_INTERVAL = 60000;

function get_hr_time() {

    return Math.floor(Number(process.hrtime.bigint()) / 1000000);
}

function report_stats(state) {

    const _stats = state.stats;
    const _elapsed = get_hr_time() - _stats.since;

    if (_elapsed < STATS_INTERVAL || !_stats.frames) {
        return;
    }

    logger.info('lcd_thread: ' + _stats.frames + ' frames in ' + Math.round(_elapsed / 1000) + 's, '
        + _stats.failed + ' failed, ' + (lcd.retry_count() - _stats.retries) + ' write retries, '
        + 'good redraw took avg ' + (_stats.ok ? Math.round(_stats.total / _stats.ok) : 0) + 'ms'
        + ' min ' + _stats.min + 'ms max ' + _stats.max + 'ms');

    state.stats = new_stats();
}

function new_stats() {

    return { since: get_hr_time(), frames: 0, ok: 0, failed: 0, total: 0, min: 0, max: 0, retries: lcd.retry_count() };
}

function start_lcd_redraw(handle, state, job) {
        
    return new Promise(fulfill => {

        const _start = get_hr_time();
        var _failed = false;

        lcd.redraw(handle, job.image).then(() => {

            // intentionally blank

        }, err => {

            _failed = true;

            logger.error('lcd_thread: start_lcd_redraw hid error: ' + err + ' (write retries so far: ' + lcd.retry_count() + ')');

        }).finally(() => {
            
            const _took = get_hr_time() - _start;
            const _stats = state.stats;

            _stats.frames++;

            if (_failed) {
                // a failed frame carries a one second libusb timeout, counting it
                // would hide how long the panel really takes to swallow a frame
                _stats.failed++;
            }
            else {
                _stats.ok++;
                _stats.total += _took;
                _stats.max = Math.max(_stats.max, _took);
                _stats.min = _stats.min ? Math.min(_stats.min, _took) : _took;
            }

            state.last_redraw_done = get_hr_time();

            report_stats(state);

            fulfill({ type: 'redraw', complete: true });
        });
    });
}

/*
 * the panel is still painting the lcd when the next full frame arrives and stops
 * reading its endpoint, which costs a full libusb timeout and drops the rest of
 * the frame. redraw was the only job type not going through a cool down
 */
function redraw_delay(state) {

    if (!state.redraw_cooldown) {
        return 0;
    }

    const _since = get_hr_time() - state.last_redraw_done;

    return _since >= state.redraw_cooldown ? 0 : state.redraw_cooldown - _since;
}

function start_lcd_update(handle, state, job, fulfill) {

    if (job && 'update' === job.type) {
    
        return lcd.refresh(handle, job.rect.x, job.rect.y, job.rect.width, job.rect.height, job.image).then(() => {

            // intentionally blank

        }, err => {          

            logger.error('lcd_thread: next_lcd_update hid error: ' + err + ' (write retries so far: ' + lcd.retry_count() + ')');

        }).finally(() => {
          
            start_lcd_update(handle, state, state.queue.shift(), fulfill);
        });
    }

    return fulfill({ type: 'update', complete: true });
}

function start_lcd_heartbeat(handle, state, job, fulfill) {

    lcd.heartbeat(handle).then(() => {

        // intentionally blank

    }, err => {

        logger.error('lcd_thread: start_lcd_heartbeat hid error: ' + err + ' (write retries so far: ' + lcd.retry_count() + ')');

    }).finally(() => {
        
        fulfill({ type: 'heartbeat', complete: false });
    });
}

function start_lcd_orientation(handle, state, job, fulfill) {
    
    lcd.set_orientation(handle, job.portrait).then(() => {

        // intentionally blank

    }, err => {

        logger.error('lcd_thread: start_lcd_orientation hid error: ' + err);

    }).finally(() => {
        
        fulfill({ type: 'orientation', complete: false });
    });
}

function with_delay(handle, state, job, call) {

    return new Promise(fulfill => {

        if ('redraw' === state.last_type) {

            return setTimeout(() => {
            
                call(handle, state, job, fulfill);
            
            }, state.refresh);
        }
        
        call(handle, state, job, fulfill);
    });
}

function refresh_device(handle, state) {    
    
    const _now = get_hr_time();
    var _promise = Promise.resolve({ type: 'idle' });

    if (state.queue.length) {

        // pending screen work always wins. a heartbeat here would be delayed by
        // state.refresh after a redraw and it does not report back to the main
        // thread, which leaves the screen frozen until the delay is over
        const _job = state.queue.shift();

        switch (_job.type) {

            case 'redraw':
                {
                    const _delay = redraw_delay(state);

                    _promise = _delay ? new Promise(fulfill => {

                        setTimeout(() => start_lcd_redraw(handle, state, _job).then(fulfill), _delay);

                    }) : start_lcd_redraw(handle, state, _job);
                }
                break;

            case 'update':   
                _promise = with_delay(handle, state, _job, start_lcd_update);
                break;
            
            case 'orientation':
                _promise = with_delay(handle, state, _job, start_lcd_orientation);
                break;

            case 'heartbeat':
                _promise = with_delay(handle, state, _job, start_lcd_heartbeat);
                break;
        }  
    }
    else {

        const _last_activity = _now - state.last_activity;
        const _last_heartbeat = _now - state.last_heartbeat;
        
        if (_last_activity > state.refresh || _last_heartbeat > state.heartbeat) {

            _promise = with_delay(handle, state, { type: 'heartbeat' }, start_lcd_heartbeat);
        }
    }

    _promise.then(rc => {
        
        if ('idle' !== rc.type) {
            
            const _took = get_hr_time() - _now;

            if ('heartbeat' === rc.type) {

                state.last_heartbeat = get_hr_time(); 
            }
            else {

                // upcall we're ready to receive next command...
                threads.parentPort.postMessage({ type: rc.type, complete: rc.complete });
            }

            state.last_type = rc.type;
            state.last_activity = get_hr_time();
        }

    }, err => {

        logger.error('lcd_thread: lcd reported an error ' + err);

    }).finally(() => {

        setTimeout(() => {

            refresh_device(handle, state);
    
        }, POLL_TIMEOUT);
    });
}

function message_handler(state, message) {

    switch (message.type) {
    
        case 'orientation':
        case 'heartbeat':
            state.queue.push(message);
            break;
            
        case 'redraw':
            state.queue.push({ type: 'redraw', image: { data: message.pixelData } });
            break;

        case 'update':                
            state.queue.push({ type: 'update', rect: message.rect, image: { data: message.pixelData }});
            break;

        case 'config':
            state.poll = message.poll || state.poll;
            state.refresh = message.refresh || state.refresh;
            state.heartbeat = message.heartbeat || state.heartbeat;
            state.redraw_cooldown = undefined !== message.redraw_cooldown ? message.redraw_cooldown : state.redraw_cooldown;
            break;

        default:
            logger.error('lcd_thread: unknown command type: ' + message.type);
            break;
    }
} 

function main(state) {

    logger.info('lcd_thread: started...');

    threads.parentPort.on('message', message => {
        message_handler(state, message);
    });

    node_hid.setDriverType('libusb');

    usb_hid.open(state.device).then(handle => {
    
        setTimeout(() => {

            refresh_device(handle, state);
        
        }, START_COOL_DOWN);
        
    }, err => {

        logger.error('lcd_thread: failed to open usbhid ' + state.device);
        logger.error(err);
    });
}

main({
    device             : threads.workerData.device,
    poll               : threads.workerData.poll,
    refresh            : threads.workerData.refresh,
    heartbeat          : threads.workerData.heartbeat,
    redraw_cooldown    : threads.workerData.redraw_cooldown || 0,
    last_heartbeat     : get_hr_time(),
    last_activity      : get_hr_time(),
    last_redraw_done   : 0,
    queue              : [],
    last_type          : 'idle',
    stats              : new_stats()
});

