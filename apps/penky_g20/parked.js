'use strict';

const IFACE = 'de.bmw.infotainment.vehicle.Vehicle2';
const FIELD = 'statusCarSpeed2';
const KMH_PER_RAW = 0.015625;
const MOVING_KMH = 3;
const INVALID_SPEED = 65535;

function watch(ctx, log) {
    let speedKmh = null;
    const handlers = {};
    handlers[FIELD] = (value) => {
        const raw = value && value.speedVehicleCentreOfGravity;
        speedKmh = typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw !== INVALID_SPEED
            ? raw * KMH_PER_RAW
            : null;
    };

    ctx.signals.watch(IFACE, '1', handlers, log).then((sub) => {
        if (sub && sub.error && log && log.warn) log.warn('speed signal: ' + sub.error);
    }).catch((error) => {
        if (log && log.warn) log.warn('speed signal: ' + error);
    });

    return {
        moving: () => speedKmh === null || speedKmh >= MOVING_KMH,
    };
}

module.exports = { watch };