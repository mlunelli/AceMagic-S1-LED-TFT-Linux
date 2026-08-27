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
const REDRAW_PACKETS = 27;

function get_hr_time() {

    return Math.floor(Number(process.hrtime.bigint()) / 1000000);
}

function new_bucket() {

    return { count: 0, ok: 0, failed: 0, total: 0, min: 0, max: 0, writes: 0 };
}

function new_stats() {

    return { since: get_hr_time(), retries: lcd.retry_count(), heartbeats: 0, heartbeats_failed: 0, redraw: new_bucket(), update: new_bucket() };
}

function record_job(bucket, took, failed, writes) {

    bucket.count++;
    bucket.writes += writes;

    if (failed) {
        // a failed job carries a full one second libusb timeout per bad packet,
        // averaging it in would hide how long the panel really needs
        bucket.failed++;
        return;
    }

    bucket.ok++;
    bucket.total += took;
    bucket.max = Math.max(bucket.max, took);
    bucket.min = bucket.min ? Math.min(bucket.min, took) : took;
}

function describe(name, bucket) {

    return bucket.count + ' ' + name + ' (' + bucket.failed + ' failed, ' + bucket.writes + ' packets) avg '
        + (bucket.ok ? Math.round(bucket.total / bucket.ok) : 0) + 'ms min ' + bucket.min + 'ms max ' + bucket.max + 'ms';
}

function report_stats(state) {

    const _stats = state.stats;
    const _elapsed = get_hr_time() - _stats.since;

    if (_elapsed < STATS_INTERVAL || !(_stats.redraw.count + _stats.update.count + _stats.heartbeats)) {
        return;
    }

    const _parts = [];

    if (_stats.redraw.count) {
        _parts.push(describe('redraws', _stats.redraw));
    }

    if (_stats.update.count) {
        _parts.push(describe('updates', _stats.update));
    }

    _parts.push(_stats.heartbeats + ' heartbeats (' + _stats.heartbeats_failed + ' failed)');
    _parts.push((lcd.retry_count() - _stats.retries) + ' write retries');

    logger.info('lcd_thread: in ' + Math.round(_elapsed / 1000) + 's: ' + _parts.join(' | '));

    state.stats = new_stats();
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
            
            record_job(state.stats.redraw, get_hr_time() - _start, _failed, REDRAW_PACKETS);

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

function start_lcd_update(handle, state, job, fulfill, tally) {

    if (!tally) {
        tally = { writes: 0, failed: 0, start: get_hr_time() };
    }

    if (job && 'update' === job.type) {

        tally.writes++;
    
        return lcd.refresh(handle, job.rect.x, job.rect.y, job.rect.width, job.rect.height, job.image).then(() => {

            // intentionally blank

        }, err => {          

            tally.failed++;

            logger.error('lcd_thread: next_lcd_update hid error: ' + err + ' (write retries so far: ' + lcd.retry_count() + ')');

        }).finally(() => {

            // only take the next job when it is another region of this same burst,
            // shifting anything else off the queue would silently drop a frame
            const _next = (state.queue.length && 'update' === state.queue[0].type) ? state.queue.shift() : null;
          
            start_lcd_update(handle, state, _next, fulfill, tally);
        });
    }

    record_job(state.stats.update, get_hr_time() - tally.start, tally.failed, tally.writes);

    report_stats(state);

    return fulfill({ type: 'update', complete: true, failed: tally.failed, writes: tally.writes });
}

function start_lcd_heartbeat(handle, state, job, fulfill) {

    state.stats.heartbeats++;

    var _failed = false;

    lcd.heartbeat(handle).then(() => {

        // intentionally blank

    }, err => {

        _failed = true;
        state.stats.heartbeats_failed++;

        logger.error('lcd_thread: start_lcd_heartbeat hid error: ' + err + ' (write retries so far: ' + lcd.retry_count() + ')');

    }).finally(() => {
        
        report_stats(state);

        fulfill({ type: 'heartbeat', complete: false, failed: _failed });
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

        // the keep alive used to reuse state.refresh, which is really the cool down
        // applied after a redraw. they are separate now, but measured on the real
        // panel the firmware drops to its disconnect screen after roughly two
        // seconds of silence, so this can never be relaxed past that
        if (_last_activity > state.keepalive || _last_heartbeat > state.heartbeat) {

            _promise = with_delay(handle, state, { type: 'heartbeat' }, start_lcd_heartbeat);
        }
    }

    _promise.then(rc => {
        
        if ('idle' !== rc.type) {
            
            const _took = get_hr_time() - _now;

            const _failed_heartbeat = ('heartbeat' === rc.type && rc.failed) ? true : false;

            if ('heartbeat' === rc.type) {

                if (!rc.failed) {
                    state.last_heartbeat = get_hr_time(); 
                }
            }
            else {

                // upcall we're ready to receive next command...
                threads.parentPort.postMessage({ type: rc.type, complete: rc.complete });
            }

            state.last_type = rc.type;

            // a failed heartbeat leaves last_activity where it was, so the next loop
            // pass sends another one right away instead of waiting out the keep alive.
            // the firmware drops to its disconnect screen after about two seconds of
            // silence and a timed out write has already eaten one of them
            if (!_failed_heartbeat) {
                state.last_activity = get_hr_time();
            }
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
            state.keepalive = message.keepalive || state.keepalive;

            if (undefined !== message.short_packets) {
                lcd.set_short_packets(message.short_packets);
            }
            break;

        default:
            logger.error('lcd_thread: unknown command type: ' + message.type);
            break;
    }
} 

function main(state) {

    logger.info('lcd_thread: started...');

    lcd.set_short_packets(state.short_packets);

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
    keepalive          : threads.workerData.keepalive || threads.workerData.refresh,
    short_packets      : threads.workerData.short_packets || false,
    last_heartbeat     : get_hr_time(),
    last_activity      : get_hr_time(),
    last_redraw_done   : 0,
    queue              : [],
    last_type          : 'idle',
    stats              : new_stats()
});

