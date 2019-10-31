'use strict';
// spatialmatch test to ensure the highest relev for a stacked zxy cell
// is used, disallowing a lower scoring cell from overwriting a previous
// entry.

const tape = require('tape');
const Carmen = require('../..');
const context = require('../../lib/geocoder/context');
const mem = require('../../lib/sources/api-mem');
const queue = require('d3-queue').queue;
const addFeature = require('../../lib/indexer/addfeature'),
    queueFeature = addFeature.queueFeature,
    buildQueued = addFeature.buildQueued;

const conf = {
    region2: new mem({ maxzoom: 6}, () => {}),
    region3: new mem({ maxzoom: 6}, () => {}),
    region4: new mem({ maxzoom: 6}, () => {}),
    region: new mem({ maxzoom: 6}, () => {}),
    place: new mem({ maxzoom: 6}, () => {}),
    address: new mem({ maxzoom: 14, geocoder_address: 1 }, () => {}),
    poi: new mem({ maxzoom: 14}, () => {}),
    poi2: new mem({ maxzoom: 14}, () => {}),
    poi3: new mem({ maxzoom: 14}, () => {}),
    poi4: new mem({ maxzoom: 14}, () => {})
};
const q = queue();

const c = new Carmen(conf);
tape('index region', (t) => {
    const feature = {
        id:1,
        properties: {
            'carmen:text':'california',
            'carmen:zxy':['6/32/32'],
            'carmen:center':[0,0],
        }
    };
    queueFeature(conf.region, feature, t.end);
});

tape('index region2', (t) => {
    const feature = {
        id:1,
        properties: {
            'carmen:text':'ca',
            'carmen:zxy':['6/1/1'],
            'carmen:center':[0,0],
        }
    };
    queueFeature(conf.region2, feature, t.end);
});

tape('index region3', (t) => {
    const feature = {
        id:1,
        properties: {
            'carmen:text':'francisco ca',
            'carmen:zxy':['6/2/2'],
            'carmen:center':[0,0],
        }
    };
    queueFeature(conf.region3, feature, t.end);
});
tape('index region4', (t) => {
    const feature = {
        id:1,
        properties: {
            'carmen:text':'cal',
            'carmen:zxy':['6/5/5'],
            'carmen:center':[0,0],
        }
    };
    queueFeature(conf.region4, feature, t.end);
});

tape('index place', (t) => {
    const feature = {
        id:2,
        properties: {
            'carmen:text':'san francisco',
            'carmen:zxy':['6/32/32'],
            'carmen:center':[2.82,-2.84],
            'carmen:score': 500
        }
    };
    queueFeature(conf.place, feature, t.end);
});

tape('index matching address', (t) => {
    const feature = {
        id:3,
        properties: {
            'carmen:text':'san',
            'carmen:zxy':['14/8320/8320'],
            'carmen:center':[2.82,-2.84],
            'carmen:addressnumber': ['1']
        },
        geometry: {
            type: 'MultiPoint',
            coordinates: [[2.82,-2.84]]
        }
    };
    queueFeature(conf.address, feature, t.end);
});

tape('index pois', (t) => {
    const q = queue();
    for (let i = 1; i <= 10; i++) {
        const feature = {
            id:i,
            properties: {
                'carmen:text':`san francisco cable car ${i}`,
                'carmen:zxy':['14/8320/8320'],
                'carmen:center':[2.82,-2.84]
            }
        }
        const featureFuzzy = {
            id:i+10,
            properties: {
                'carmen:text':`sen francisco cable car ${i}`,
                'carmen:zxy':['14/8320/8320'],
                'carmen:center':[2.82,-2.84]
            }
        }
        q.defer(queueFeature, conf.poi, feature);
        q.defer(queueFeature, conf.poi2, featureFuzzy);
        q.defer(queueFeature, conf.poi3, featureFuzzy);
        q.defer(queueFeature, conf.poi4, featureFuzzy);
    }
    q.awaitAll(t.end);
})
tape('build queued features', (t) => {
    const q = queue();
    Object.keys(conf).forEach((c) => {
        q.defer((cb) => {
            buildQueued(conf[c], cb);
        });
    });
    q.awaitAll(t.end);
});

tape('test stack length penalty', (t) => {
    c.geocode('san francisco ca', { proximity: [0,0], spatialmatch_stack_limit: 5 }, (err, res) => {
        t.ifError(err);
        t.equals(res.features[0].id, 'place.2');
        t.end();
    });
});

tape('teardown', (t) => {
    context.getTile.cache.reset();
    t.end();
});

