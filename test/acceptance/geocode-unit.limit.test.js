'use strict';
// Test geocoder_tokens

const tape = require('tape');
const Carmen = require('../..');
const context = require('../../lib/geocoder/context');
const mem = require('../../lib/sources/api-mem');
const queue = require('d3-queue').queue;
const addFeature = require('../../lib/indexer/addfeature'),
    queueFeature = addFeature.queueFeature,
    buildQueued = addFeature.buildQueued;

(() => {
    const conf = {
        country: new mem({
            maxzoom: 6
        }, () => {}),
        place: new mem({
            maxzoom: 6
        }, () => {})
    };
    const c = new Carmen(conf);
    tape('index country', (t) => {
        queueFeature(conf.country, {
            id: 1,
            properties: {
                'carmen:text':'United States',
                'carmen:center': [0,0],
                'carmen:zxy': ['6/32/32']
            }
        }, t.end);
    });
    tape('index place', (t) => {
        const q = queue(1);
        for (let i = 1; i < 21; i++) q.defer((i, done) => {
            queueFeature(conf.place, {
                id:i,
                properties: {
                    'carmen:text':'place ' + i,
                    'carmen:center': [0,0],
                },
                geometry: {
                    type: 'Point',
                    coordinates: [0,0]
                }
            }, done);
        }, i);
        q.awaitAll(t.end);
    });

    tape('build queued features', (t) => {
        const q = queue();
        Object.keys(conf).forEach((c) => {
            q.defer((cb) => {
                buildQueued(conf[c], cb);
            });
        });
        q.awaitAll(t.end);
    });

    tape('default response is 5 features (forward)', (t) => {
        c.geocode('place', {  }, (err, res) => {
            t.ifError(err);
            t.equal(res.features.length, 5, 'returns 5 results');
            t.equal(res.features[0].place_name, 'place 11, United States');
            t.equal(res.features[1].place_name, 'place 1, United States');
            t.equal(res.features[2].place_name, 'place 3, United States');
            t.equal(res.features[3].place_name, 'place 4, United States');
            t.equal(res.features[4].place_name, 'place 5, United States');
            t.end();
        });
    });
    tape('limit 1 result (forward)', (t) => {
        c.geocode('place', { limit: 1 }, (err, res) => {
            t.ifError(err);
            t.equal(res.features.length, 1, 'returns 1 result');
            t.equal(res.features[0].place_name, 'place 11, United States');
            t.end();
        });
    });
    tape('limit 10 results (forward)', (t) => {
        c.geocode('place', { limit: 10 }, (err, res) => {
            t.ifError(err);
            t.equal(res.features.length, 10, 'returns 10 results');
            t.equal(res.features[0].place_name, 'place 11, United States');
            t.equal(res.features[1].place_name, 'place 1, United States');
            t.equal(res.features[2].place_name, 'place 3, United States');
            t.equal(res.features[3].place_name, 'place 4, United States');
            t.equal(res.features[4].place_name, 'place 5, United States');
            t.equal(res.features[5].place_name, 'place 6, United States');
            t.equal(res.features[6].place_name, 'place 7, United States');
            t.equal(res.features[7].place_name, 'place 8, United States');
            t.equal(res.features[8].place_name, 'place 9, United States');
            t.equal(res.features[9].place_name, 'place 10, United States');
            t.end();
        });
    });
    tape('limit 11 results (forward)', (t) => {
        c.geocode('place', { limit: 11 }, (err, res) => {
            t.ifError(err);
            t.equal(res.features.length, 10, 'hard limit of 10');
            t.equal(res.features[0].place_name, 'place 11, United States');
            t.equal(res.features[1].place_name, 'place 1, United States');
            t.equal(res.features[2].place_name, 'place 3, United States');
            t.equal(res.features[3].place_name, 'place 4, United States');
            t.equal(res.features[4].place_name, 'place 5, United States');
            t.equal(res.features[5].place_name, 'place 6, United States');
            t.equal(res.features[6].place_name, 'place 7, United States');
            t.equal(res.features[7].place_name, 'place 8, United States');
            t.equal(res.features[8].place_name, 'place 9, United States');
            t.equal(res.features[9].place_name, 'place 10, United States');
            t.end();
        });
    });
})();

(() => {
    const conf = {
        place: new mem({
            maxzoom: 6
        }, () => {}),
        address: new mem({
            maxzoom: 12,
            geocoder_name: 'address',
            geocoder_type: 'address',
            geocoder_address: true
        }, () => {}),
        poi: new mem({
            maxzoom: 12,
            geocoder_name: 'poi',
            geocoder_type: 'poi'
        }, () => {})
    };
    const c = new Carmen(conf);
    tape('index place', (t) => {
        queueFeature(conf.place, {
            id: 1,
            properties: {
                'carmen:text':'west virginia',
                'carmen:center': [-79.37922477722168,38.832871481546036],
                'carmen:zxy': ['6/17/24']
            }
        }, t.end);
    });

    const coords = [
        [-79.37663912773132,38.83417524443351],
        [-79.37698781490326,38.83414599360498],
        [-79.37705218791960,38.83398302448309],
        [-79.37690734863281,38.83439671460232],
        [-79.37739551067352,38.83437582121962],
        [-79.37776565551758,38.83445939471365],
        [-79.37820553779602,38.83435910650903],
        [-79.37737405300139,38.83381587627815],
        [-79.37737941741943,38.83361111919213],
        [-79.37780320644379,38.83375319560010]
    ];

    tape('index poi', (t) => {
        const q = queue(1);
        for (let i = 1; i < 6; i++) q.defer((i, done) => {
            queueFeature(conf.poi, {
                id:i,
                properties: {
                    'carmen:text':'seneca rocks ' + i,
                    'carmen:center': coords[i - 1],
                },
                geometry: {
                    type: 'Point',
                    coordinates: coords[i - 1]
                }
            }, done);
        }, i);
        q.awaitAll(t.end);
    });

    tape('index address', (t) => {
        queueFeature(conf.address, {
            id: 1,
            properties: {
                'carmen:addressnumber': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                'carmen:text':'main road',
                'carmen:center': coords[0],
            },
            geometry: {
                type: 'MultiPoint',
                coordinates: coords
            }
        }, t.end);
    });

    tape('build queued features', (t) => {
        const q = queue();
        Object.keys(conf).forEach((c) => {
            q.defer((cb) => {
                buildQueued(conf[c], cb);
            });
        });
        q.awaitAll(t.end);
    });

    tape('default response is 1 features (reverse)', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { }, (err, res) => {
            t.ifError(err);
            t.equal(res.features.length, 3, 'returns 1 result of 3 context');
            t.equal(res.features[0].place_name, 'seneca rocks 5, main road, west virginia');
            t.equal(res.features[1].place_name, '5 main road, west virginia');
            t.equal(res.features[2].place_name, 'west virginia');
            t.end();
        });
    });
    tape('Limit only works with type (reverse)', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 2 }, (err, res) => {
            t.ok(err);
            t.end();
        });
    });
    tape('limit 2 results (reverse)', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 2, types: ['poi'] }, (err, res) => {
            t.ifError(err);
            t.equal(res.features.length, 2, 'returns 2 results');
            t.end();
        });
    });
    tape('limit 5 results (reverse)', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 5, types: ['poi'] }, (err, res) => {
            t.ifError(err);
            t.equal(res.features[0].place_name, 'seneca rocks 5, main road, west virginia');
            t.equal(res.features[1].place_name, 'seneca rocks 2, main road, west virginia');
            t.equal(res.features[2].place_name, 'seneca rocks 3, main road, west virginia');
            t.equal(res.features[3].place_name, 'seneca rocks 4, main road, west virginia');
            t.equal(res.features[4].place_name, 'seneca rocks 1, main road, west virginia');
            t.equal(res.features.length, 5, 'returns 5 results');
            t.end();
        });
    });
    tape('limit 6 results (reverse)', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 6, types: ['poi'] }, (err, res) => {
            t.ifError(err);
            t.equal(res.features[0].place_name, 'seneca rocks 5, main road, west virginia');
            t.equal(res.features[1].place_name, 'seneca rocks 2, main road, west virginia');
            t.equal(res.features[2].place_name, 'seneca rocks 3, main road, west virginia');
            t.equal(res.features[3].place_name, 'seneca rocks 4, main road, west virginia');
            t.equal(res.features[4].place_name, 'seneca rocks 1, main road, west virginia');
            t.equal(res.features.length, 5, 'returns 5 results - hard limit');
            t.end();
        });
    });
    tape('limit 5 results (address)', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 5, types: ['address'] }, (err, res) => {
            t.ifError(err);
            t.equal(res.features[0].place_name, '5 main road, west virginia');
            t.equal(res.features[1].place_name, '6 main road, west virginia');
            t.equal(res.features[2].place_name, '2 main road, west virginia');
            t.equal(res.features[3].place_name, '3 main road, west virginia');
            t.equal(res.features[4].place_name, '8 main road, west virginia');
            t.equal(res.features.length, 5, 'returns 5 results - hard limit');
            t.end();
        });
    });
})();

tape('teardown', (t) => {
    context.getTile.cache.reset();
    t.end();
});

// Handle addressclusters
(() => {
    const conf = {
        place: new mem({
            maxzoom: 6
        }, () => {}),
        address: new mem({
            maxzoom: 12,
            geocoder_address: 1
        }, () => {})
    };
    const c = new Carmen(conf);
    tape('index place', (t) => {
        queueFeature(conf.place, {
            id: 1,
            properties: {
                'carmen:text':'west virginia',
                'carmen:center': [-79.37922477722168,38.832871481546036],
                'carmen:zxy': ['6/17/24']
            }
        }, t.end);
    });

    tape('index address', (t) => {
        queueFeature(conf.address, {
            id:1,
            properties: {
                'carmen:text':'main street',
                'carmen:center': [-79.37663912773132,38.83417524443351],
                'carmen:addressnumber': [
                    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'
                ]
            },
            geometry: {
                type: 'MultiPoint',
                coordinates: [
                    [-79.37663912773132,38.83417524443351],
                    [-79.37698781490326,38.83414599360498],
                    [-79.37705218791960,38.83398302448309],
                    [-79.37690734863281,38.83439671460232],
                    [-79.37739551067352,38.83437582121962],
                    [-79.37776565551758,38.83445939471365],
                    [-79.37820553779602,38.83435910650903],
                    [-79.37737405300139,38.83381587627815],
                    [-79.37737941741943,38.83361111919213],
                    [-79.37780320644379,38.83375319560010]
                ]
            }
        }, t.end);
    });

    tape('build queued features', (t) => {
        const q = queue();
        Object.keys(conf).forEach((c) => {
            q.defer((cb) => {
                buildQueued(conf[c], cb);
            });
        });
        q.awaitAll(t.end);
    });

    tape('Reverse Cluster', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 5, types: ['address'] }, (err, res) => {
            t.equal(res.features[0].place_name, '5 main street, west virginia');
            t.equal(res.features[1].place_name, '6 main street, west virginia');
            t.equal(res.features[2].place_name, '2 main street, west virginia');
            t.equal(res.features[3].place_name, '3 main street, west virginia');
            t.equal(res.features[4].place_name, '8 main street, west virginia');
            t.equal(res.features.length, 5, 'returns 5 results - hard limit');
            t.ifError(err);
            t.end();
        });
    });
})();

tape('teardown', (t) => {
    context.getTile.cache.reset();
    t.end();
});

// Handle ITP lines
(() => {
    const conf = {
        place: new mem({
            maxzoom: 6
        }, () => {}),
        address: new mem({
            maxzoom: 12,
            geocoder_address: 1
        }, () => {})
    };
    const c = new Carmen(conf);
    tape('index place', (t) => {
        queueFeature(conf.place, {
            id: 1,
            properties: {
                'carmen:text':'west virginia',
                'carmen:center': [-79.37922477722168,38.832871481546036],
                'carmen:zxy': ['6/17/24']
            }
        }, t.end);
    });

    tape('index address', (t) => {
        queueFeature(conf.address, {
            id:1,
            properties: {
                'carmen:text':'main street',
                'carmen:center': [-79.37729358673094, 38.834651613377574],
                'carmen:rangetype': 'tiger',
                'carmen:parityl': ['E','E','E','E'],
                'carmen:parityr': ['O','O','O','O'],
                'carmen:rfromhn': ['1','5','9','13'],
                'carmen:rtohn':   ['3','7','11','15'],
                'carmen:lfromhn': ['2','6','10','14'],
                'carmen:ltohn':   ['4','8','12','16']
            },
            geometry: {
                type: 'MultiLineString',
                coordinates: [
                    [[-79.378382563591,38.83475190117003],[-79.37798023223877,38.83472265057851]],
                    [[-79.37795341014862,38.83472265057851],[-79.37729358673094,38.834651613377574]],
                    [[-79.37725603580475,38.83463907739358],[-79.3767088651657,38.834593112100016]],
                    [[-79.37676787376404,38.834430144001914],[-79.37698245048523,38.833962130978954]]
                ]
            }
        }, t.end);
    });

    tape('build queued features', (t) => {
        const q = queue();
        Object.keys(conf).forEach((c) => {
            q.defer((cb) => {
                buildQueued(conf[c], cb);
            });
        });
        q.awaitAll(t.end);
    });

    tape('Reverse ITP', (t) => {
        c.geocode('-79.37745451927184,38.83420867393712', { limit: 3, types: ['address'] }, (err, res) => {
            t.equal(res.features[0].place_name, '16 main street, west virginia');
            t.equal(res.features[1].place_name, '10 main street, west virginia');
            t.equal(res.features[2].place_name, '8 main street, west virginia');
            t.equal(res.features.length, 3, 'returns 3 results');
            t.ifError(err);
            t.end();
        });
    });
})();

tape('teardown', (t) => {
    context.getTile.cache.reset();
    t.end();
});
