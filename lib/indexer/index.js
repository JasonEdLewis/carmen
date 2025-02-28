'use strict';
const feature = require('../util/feature'),
    queue = require('d3-queue').queue,
    indexdocs = require('./indexdocs'),
    split = require('split'),
    fs = require('fs-extra'),
    cxxcache = require('./cxxcache'),
    TIMER = process.env.TIMER;

module.exports = index;
module.exports.update = update;
module.exports.store = store;
module.exports.cleanDocs = cleanDocs;

/**
 * The main interface for building an index
 *
 * @access public
 *
 * @param {Geocoder} geocoder - a {@link Geocoder} instance
 * @param {stream.Readable} from - a stream of geojson features
 * @param {CarmenSource} to - the interface to the index's destinaton
 * @param {Object} options - options
 * @param {number} options.zoom - the max zoom level for the index
 * @param {stream.Writable} options.output - the output stream for
 * @param {PatternReplaceMap} options.tokens - a pattern-based string replacement specification
 * @param {function} callback - A callback function
 *
 */
function index(geocoder, from, to, options, callback) {
    options = options || {};

    const zoom = options.zoom + parseInt(options.geocoder_resolution || 0,10);

    if (!to) return callback(new Error('to parameter required'));
    if (!from) return callback(new Error('from parameter required'));
    if (!options) return callback(new Error('options parameter required'));
    if (!zoom) return callback(new Error('must specify zoom level in options'));
    if (!options.output) return callback(new Error('must specify output stream in options'));
    if (!from.readable) return callback(new Error('input stream must be readable'));

    let inStream = from.pipe(split());
    let docs = [];

    inStream.on('data', (doc) => {
        if (doc === '') return;
        docs.push(JSON.parse(doc));
        if (docs.length === 10000) {
            inStream.pause();
            indexDocs(null, docs, options);
        }
    });
    inStream.on('end', () => {
        inStream = false;
        indexDocs(null, docs, options);
    });
    inStream.on('error', (err) => {
        return callback(err);
    });

    getDocs(options);

    function getDocs(options) {
        if (TIMER) console.time('getIndexableDocs');
        if (!inStream) return indexDocs(null, [], options);
        docs = [];
        inStream.resume();
    }

    function indexDocs(err, docs, options) {
        to.startWriting((err) => {
            if (err) return callback(err);

            if (TIMER) console.timeEnd('getIndexableDocs');
            if (err) return callback(err);
            if (!docs.length) {
                geocoder.emit('store');
                store(to, (err) => {
                    if (err) return callback(err);
                    to.stopWriting(callback);
                });
            } else {
                geocoder.emit('index', docs.length);

                update(to, docs, {
                    zoom: zoom,
                    output: options.output,
                    tokens: options.tokens,
                    openStream: true
                }, (err) => {
                    if (err) return callback(err);
                    getDocs(options);
                });
            }
        });
    }
}

/**
 * Update
 *
 * Updates the source's index with provided docs.
 *
 * @param {CarmenSource} source - the source to be updated
 * @param {Array<Feature>} docs - an array of GeoJSON `Feature` documents
 * @param {Object} options - TODO
 * @param {Function} callback - a callback function
 */
function update(source, docs, options, callback) {
    // First pass over docs.
    // - Creates termsets (one or more arrays of termids) from document text.
    // - Tallies frequency of termids against current frequencies compiling a
    //   final in-memory frequency count of all terms involved with this set of
    //   documents to be indexed.
    // - Stores new frequencies.

    if (!options) return callback(new Error('options argument requied'));
    if (!options.zoom) return callback(new Error('options.zoom argument requied'));

    indexdocs(docs, source, {
        zoom: options.zoom,
        geocoder_tokens: source.geocoder_tokens,
        tokens: options.tokens
    }, updateCache);

    function updateCache(err, patch) {
        if (err) return callback(err);
        if (TIMER) console.timeEnd('update:indexdocs');

        // Output geometries to vectorize
        if (options.output) {
            for (let docs_it = 0; docs_it < patch.vectors.length; docs_it++) {
                options.output.write(JSON.stringify(patch.vectors[docs_it]) + '\n');
            }
            if (!options.openStream) options.output.end();
        }

        // ? Do this in master?
        const features = {};
        const q = queue(500);
        q.defer((features, callback) => {
            if (TIMER) console.time('update:putFeatures');

            feature.putFeatures(source, cleanDocs(source, patch.docs), (err) => {
                if (TIMER) console.timeEnd('update:putFeatures');
                if (err) return callback(err);
                // @TODO manually calls _commit on MBTiles sources.
                // This ensures features are persisted to the store for the
                // next run which would not necessarily be the case without.
                // Given that this is a very performant pattern, commit may
                // be worth making a public function in node-mbtiles (?).
                return source._commit ? source._commit(callback) : callback();
            });
        }, features);
        setParts(patch.grid, 'grid');
        const dictcache = source._dictcache;
        for (let i = 0; i < patch.text.length; i++) {
            if ((patch.text[i] !== null) && (patch.text[i].trim().length > 0)) {
                dictcache.writer.insert(patch.text[i].split(' '));
            }
        }
        q.awaitAll(callback);

        function setParts(data, type) {
            q.defer((data, type, callback) => {
                const ids = Object.keys(data);
                const cache = source._geocoder;
                if (TIMER) console.time('update:setParts:' + type);

                let id;
                for (let i = 0; i < ids.length; i++) {
                    id = ids[i];
                    // This merges new entries on top of old ones.
                    data[id].forEach((langGrids, langList) => {
                        let langArg;
                        if (langList.includes('all')) {
                            langArg = null;
                        } else {
                            langArg = [];
                            for (const lang of langList.split(',')) {
                                if (!source.lang.lang_map.hasOwnProperty(lang)) {
                                    console.warn("can't index text for index", source.id, 'because it has no lang code', lang);
                                    continue;
                                }
                                langArg.push(source.lang.lang_map[lang]);
                            }
                            if (langArg.length === 0) langArg = null;
                        }
                        if (id) cache.grid.set(id, langGrids, langArg, true);
                    });
                }
                if (TIMER) console.timeEnd('update:setParts:' + type);
                callback();
            }, data, type);
        }
    }
}

/**
 * Store
 *
 * Serialize and make permanent the index currently in memory for a source.
 *
 * @param {object} source - Carmen source
 * @param {callback} callback - accepts error argument
 */
function store(source, callback) {

    const cache = source._geocoder;

    const q = queue();

    q.defer((callback) => {
        // write word replacements to metadata
        source._dictcache.writer.loadWordReplacements(source.categorized_replacement_words.simple);
        source._dictcache.writer.finish();
        callback();
    });

    q.defer((callback) => {
        const rocksdb = source.getBaseFilename() + '.grid.rocksdb';

        // steps:
        //   - pack to a temp directory
        //   - delete current rocks cache
        //   - move temp rocks overtop current rocks position
        //   - create new rocks cache

        const tmpdir = require('os').tmpdir() + '/temp.' + Math.random().toString(36).substr(2, 5);

        cache['grid'].pack(tmpdir);

        const id = cache['grid'].id;
        delete cache['grid'];

        fs.move(tmpdir, rocksdb, { clobber: true }, (err) => {
            if (!err) {
                cache['grid'] = new cxxcache.RocksDBCache(id, rocksdb);
            }
            callback(err);
        });
    });

    q.awaitAll(callback);
}

/**
 * Cleans a doc for storage based on source properties.
 * Currently only drops _geometry data for non interpolated
 * address sources.
 *
 * @param {object} source - carmen source
 * @param {object[]} docs - array of geojson docs
 *
 * @return {object[]} "cleaned" docs
 */
function cleanDocs(source, docs) {
    for (let i = 0; i < docs.length; i++) {
        // source is not address enabled
        if (!source.geocoder_address) {
            delete docs[i].geometry;
        }
    }
    return docs;
}
