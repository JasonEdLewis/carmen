'use strict';
const proximity = require('../util/proximity.js');
const queue = require('d3-queue').queue;
const coalesce = require('@mapbox/carmen-cache').coalesce;
const bbox = require('../util/bbox.js');
const cheapRuler = require('cheap-ruler');
const roundTo = require('../util/round-to.js');
const termops = require('../text-processing/termops');
const constants = require('../constants');
const PREFIX_SCAN = require('@mapbox/carmen-cache').PREFIX_SCAN;

module.exports = spatialmatch;
module.exports.stackable = stackable;
module.exports.rebalance = rebalance;
module.exports.allowed = allowed;
module.exports.sortByRelevLengthIdx = sortByRelevLengthIdx;
module.exports.sortByZoomIdx = sortByZoomIdx;

/**
 * spatialmatch determines whether indexes can be spatially stacked and discards indexes that cannot be stacked together
 *
 * @access public
 *
 * @param {Array} query a list of terms composing the query to Carmen
 * @param {Array} phrasematchResults for subquery permutations generated by ./lib/phrasematch
 * @param {Object} options passed in with the query
 * @param {function} callback callback called with indexes that could be spatially stacked
 */
function spatialmatch(query, phrasematchResults, options, callback) {
    let stacks;

    if (phrasematchResults.length) {
        // Fuzzy matching may have produced multiple phrasematches that will
        // behave identically when stacking -- they come from the same index
        // and have the same mask and weight. To avoid duplicate effort, we
        // collapse our matches down to ones that are distinct along these axes,
        // then expand them back out again after stacking.
        const archetypes = collapseToArchetypes(phrasematchResults);
        let arch_stacks = stackable(archetypes, options.stackable_limit);
        arch_stacks = allowed(arch_stacks, options);
        arch_stacks.forEach((arch_stack) => { arch_stack.sort(sortByZoomIdx); });
        arch_stacks.sort(sortByRelevLengthIdx);
        arch_stacks = arch_stacks.slice(0, options.spatialmatch_stack_limit);
        stacks = expandFromArchetypes(arch_stacks, options.spatialmatch_stack_limit);
    } else {
        stacks = [];
    }

    // Rebalance weights, relevs of stacks here.
    for (let i = 0; i < stacks.length; i++) {
        stacks[i] = rebalance(query, stacks[i]);
    }

    const waste = [];

    coalesceStacks();

    /** coalesce all stacks. */
    function coalesceStacks() {
        const q = queue();
        for (let i = 0; i < stacks.length; i++) q.defer(coalesceStack, stacks[i]);
        q.awaitAll(coalesceFinalize);
    }

    /**
     * Coalesce a single stack, add debugging info.
     * @param {Array} stack - phrasematch results
     * @param {Callback} callback - callback
     * @returns {undefined}
     */
    function coalesceStack(stack, callback) {
        // Proximity option is set.
        // Convert proximity to xy @ highest zoom level for this stack
        const coalesceOpts = {};
        // the most specific (last) stack component can declare this to be a
        // partial-number match, which will apply different rules in verifymatch
        const partialNumber = stack.length > 0 ? stack[stack.length - 1].partialNumber : false;
        // see if we have address metadata on any of the entries
        const addressDataByIdx = new Map();
        for (const match of stack) {
            if (match.address) {
                addressDataByIdx.set(match.idx, match.address);
            }
        }
        if (options) {
            if (options.proximity) {
                let l = stack.length;
                let maxZoom = 0;
                while (l--) {
                    maxZoom = Math.max(maxZoom, stack[l].zoom);
                }
                coalesceOpts.centerzxy = proximity.center2zxy(
                    options.proximity,
                    maxZoom
                );
                coalesceOpts.radius = stack[stack.length - 1].radius || constants.COALESCE_PROXIMITY_RADIUS;
            }

            if (partialNumber && options.proximity) {
                // imply a bbox around partial-number matches to make their
                // search space more manageable
                const ruler = cheapRuler(options.proximity[1], 'miles');
                let pnBbox = ruler.bufferPoint(options.proximity, 10);
                if (options.bbox) {
                    pnBbox = bbox.intersection(pnBbox, options.bbox);
                    // if the implied bounding box doesn't overlap with the
                    // requested bounding box, bail on this stack
                    if (!pnBbox) return callback(null, []);
                }
                coalesceOpts.bboxzxy = bbox.insideTile(pnBbox, stack[0].zoom);
            } else if (options.bbox) {
                coalesceOpts.bboxzxy = bbox.insideTile(options.bbox, stack[0].zoom);
            }
        }

        coalesce(stack, coalesceOpts, (err, cacheSpatialmatches) => {
            // Include text for debugging with each matched feature.
            const stackByIdx = getStackByIdx(stack);
            cacheSpatialmatches = cacheSpatialmatches || [];

            if (cacheSpatialmatches.length === 0) {
                waste.push(Array.from(stackByIdx.keys()));
            }

            const spatialmatches = [];
            for (let i = 0; i < cacheSpatialmatches.length; i++) {
                spatialmatches.push(new Spatialmatch(cacheSpatialmatches[i], stackByIdx, addressDataByIdx, partialNumber));
            }

            callback(null, spatialmatches);
        });
    }

    /**
     * Final feature collection and sort.
     * @param {Error} err - error
     * @param {Array<Array<Object>>} results - array of results from carmen-cache
     * @returns {undefined}
     */
    function coalesceFinalize(err, results) {
        if (err) return callback(err);
        let combined = [];
        combined = combined.concat.apply(combined, results);
        combined.sort(sortByRelev);

        // Ascending and Descending order here refers to being able to support
        // `address, place, region, country` and `country, region, place, address`
        // Also supports being able to return a single feature that hasn't been
        // stacked with another index
        const sets = {};
        const doneAscending = {};
        const doneDescending = {};
        const doneSingle = {};
        const filteredSpatialmatches = [];
        for (let i = 0; i < combined.length; i++) {
            const spatialmatch = combined[i];
            const covers = spatialmatch.covers;
            for (let j = 0; j < covers.length; j++) {
                const id = covers[j].tmpid;
                if (!sets[id] || sets[id].relev < covers[j].relev) {
                    sets[id] = covers[j];
                }
            }

            const tmpid = covers[0].tmpid;
            // only allow one result in each direction
            if (covers.length > 1 && covers[0].idx > covers[1].idx && !doneDescending[tmpid]) {
                doneDescending[tmpid] = true;
                filteredSpatialmatches.push(spatialmatch);
            } else if (covers.length > 1 && covers[0].idx < covers[1].idx && !doneAscending[tmpid]) {
                doneAscending[tmpid] = true;
                filteredSpatialmatches.push(spatialmatch);
            } else if (covers.length === 1 && !doneAscending[tmpid] && !doneDescending[tmpid] && !doneSingle[tmpid]) {
                doneSingle[tmpid] = true;
                filteredSpatialmatches.push(spatialmatch);
            }
        }

        return callback(null, { results: filteredSpatialmatches, sets: sets, waste: waste });
    }
}

/**
 * Asseumble Phrasematches into groups that can be treated the identically in stackable
 *
 * @param {Array<object>} phrasematchResults - list of phrasematch results
 * @returns {Array<object>} list of phrasematch archetypes
 */
function collapseToArchetypes(phrasematchResults) {
    const outResults = [];
    for (const inResult of phrasematchResults) {
        const uniqMap = new Map();
        for (const inMatch of inResult.phrasematches) {
            const signature = inMatch.mask + '-' + inMatch.weight + '-' + inMatch.editMultiplier + '-' + inMatch.prefix;
            let outMatch = uniqMap.get(signature);
            if (!outMatch) {
                outMatch = {
                    mask: inMatch.mask,
                    weight: inMatch.weight,
                    editMultiplier: inMatch.editMultiplier,
                    zoom: inMatch.zoom,
                    idx: inResult.idx,
                    scorefactor: inMatch.scorefactor,
                    proxMatch: inMatch.proxMatch,
                    catMatch: inMatch.catMatch,
                    prefix: inMatch.prefix,
                    exemplars: []
                };
                uniqMap.set(signature, outMatch);
            }
            outMatch.exemplars.push(inMatch);
        }
        const collapsed = Array.from(uniqMap.values());
        // sometimes we can get into a situation where the very last token matches a whole bunch of token replacement candidates
        // and if that's the only token in the match, we don't have help from surrounding words in the phrase as context to
        // figure out whether or not that replacement is actually likely; these kinds of matches tend to be low-quality and
        // crowd out better matches from other indexes, so if we found ourselves in that very specific situation (one-word
        // prefix match at edit distance 0 and prefix ending and there are more than two of them) nerf the whole group a little
        for (const group of collapsed) {
            if (
                group.exemplars[0].subquery.length === 1 &&
                group.exemplars[0].subquery.edit_distance === 0 &&
                group.prefix !== PREFIX_SCAN.disabled &&
                group.exemplars.length > 2
            ) {
                group.editMultiplier *= .99;
            }
        }
        outResults.push({
            phrasematches: Array.from(collapsed),
            idx: inResult.idx,
            nmask: inResult.nmask,
            bmask: inResult.bmask
        });
    }
    return outResults;
}


/**
 * Expand previously grouped Phrasematches
 *
 * @param {Array<Array<object>>} stacks - list of stacked phrasematch archetypes
 * @param {number} maxOut - stack output limit
 * @returns {Array<Array<object>>} list of stacked phrasematch objects
 */
function expandFromArchetypes(stacks, maxOut) {
    const out = [];
    for (const stack of stacks) {
        const done = expandFromArchetypesInner(stack, maxOut, 0, [], out);
        if (done) break;
    }
    return out;
}

/**
 * Recursively expand previously grouped Phrasematches, invoked via expandFromArchetypes
 *
 * @param {Array<object>} stack -  array of stacked phrasematch archetype
 * @param {number} maxOut - stack output limit
 * @param {number} matchIdx - working position in stack
 * @param {Array<object>} soFar - working set of phrasematch objects
 * @param {Array<object>} out - list of phrasematch objects to return
 * @returns {boolean} true if recursion is complete or limit is reached
 */
function expandFromArchetypesInner(stack, maxOut, matchIdx, soFar, out) {
    if (matchIdx === stack.length - 1) {
        // this is innermost recursion round
        for (const exemplar of stack[matchIdx].exemplars) {
            const outStack = soFar.slice();
            outStack.push(exemplar);
            outStack.relev = stack.relev;
            outStack.adjRelev = stack.adjRelev;
            out.push(outStack);
            if (out.length >= maxOut) return true;
        }
        return false;
    } else {
        for (const exemplar of stack[matchIdx].exemplars) {
            const outStack = soFar.slice();
            outStack.push(exemplar);
            const done = expandFromArchetypesInner(stack, maxOut, matchIdx + 1, outStack, out);
            if (done) return done;
        }
        return false;
    }
}

/**
 * Filter an array of stacks down to only those whose maxidx is allowed
 * by a passed in allowed_idx filter.
 * @param {Array} stacks - array of phrasematch results
 * @param {Object} options - query options
 * @return {Array} filtered list of stacks
 */
function allowed(stacks, options) {
    if (!options.allowed_idx) return stacks;
    const filtered = [];
    for (let i = 0; i < stacks.length; i++) {
        let stack_maxidx = 0;
        for (let j = 0; j < stacks[i].length; j++) {
            stack_maxidx = Math.max(stack_maxidx, stacks[i][j].idx);
        }
        if (options.allowed_idx[stack_maxidx]) {
            filtered.push(stacks[i]);
        }
    }
    return filtered;
}

/**
 * Generate a map of stack idx to data
 * @param {Array<object>} stack - list of phrasematches
 * @return {Map} matched results keyed by index.
 */
function getStackByIdx(stack) {
    const byIdx = new Map();
    let l = stack.length;
    while (l--) byIdx.set(stack[l].idx, stack[l]);
    return byIdx;
}

// For a given set of phrasematch results across multiple indexes,
// provide all relevant stacking combinations using phrase masks to
// exclude colliding matches.
// Features can't be stacked together if:
// 1. The bmask of an index represents a mask of all indexes that their geocoder_stacks do not intersect with, so if an index's bmask contains
// the idx of the next index they cannot be stacked together
// 2. The nmask of an index is the bitmasks of all the tokens in the subquery. Two indexes that have the same nmask should not be stacked together. For example: `main st` in new york and `st martin` in new york shouldn't be stacked together
// 3. If two features have the same mask values they shouldn't be stacked together

/**
 * stackable
 *
 * @param {Array} phrasematchResults - generated for each subquery permutation
 * @param {Number} limit - output limit
 * @param {Object} memo - memoization object, used for caching result to check relevance, masks across different indexes
 * @param {Number} idx - index number
 * @param {Number} mask - caluculated by phrasematch; is used to represent all possible cominations
 * @param {Number} nmask - used to determine whether to two indexes have the same tokens which means they cannot be stacked together
 * @param {Array} stack - a list of indexes that stack spatially
 * @param {Number} relev - relevance score for each feature
 * @param {Number} adjRelev - adjusted relevance score for each feature
 * @returns {Array<Array<object>>} Arrays of phrasematch archetypes
 */
function stackable(phrasematchResults, limit, memo, idx, mask, nmask, stack, relev, adjRelev) {
    if (memo === undefined) {
        memo = {
            stacks: [],
            maxStacks: [],
            maxRelev: 0
        };
        idx = 0;
        mask = 0;
        nmask = 0;
        stack = [];
        relev = 0;
        adjRelev = 0;
    }

    // Recurse, skipping this level
    if (phrasematchResults[idx + 1] !== undefined) {
        stackable(phrasematchResults, limit, memo, idx + 1, mask, nmask, stack, relev, adjRelev);
    }

    const phrasematchResult = phrasematchResults[idx];

    if (nmask & phrasematchResult.nmask) return;

    // For each stacked item check the next bmask for its idx.
    // If the bmask includes the idx these indexes cannot stack
    // (their geocoder_stack do not intersect at all).
    const bmask = phrasematchResult.bmask;
    for (let j = 0; j < stack.length; j++) {
        if (bmask[stack[j].idx]) return;
    }

    // Recurse, including this level
    const phrasematches = phrasematchResult.phrasematches;
    for (let i = 0; i < phrasematches.length; i++) {
        const next = phrasematches[i];
        if (mask & next.mask) continue;

        // compare index order to input order to determine direction
        if (stack.length &&
            stack[0].idx >= next.idx &&
            mask &&
            mask < next.mask) continue;

        const targetStack = stack.slice(0);
        const targetMask = mask | next.mask;
        const targetNmask = nmask | phrasematchResult.nmask;
        targetStack.relev = relev + next.weight;
        targetStack.adjRelev = adjRelev + (next.weight * next.editMultiplier);

        // ensure order of targetStack maintains lowest mask value at the
        // first position. ensure direction check above works.
        if (next.mask < mask) {
            targetStack.unshift(next);
        } else {
            targetStack.push(next);
        }

        if (targetStack.relev > 0.5) {
            if (targetStack.relev > memo.maxRelev) {
                if (memo.maxStacks.length >= limit) {
                    memo.stacks = memo.maxStacks;
                    memo.maxStacks = [targetStack];
                } else {
                    memo.maxStacks.push(targetStack);
                }
                memo.maxRelev = targetStack.relev;
            } else if (targetStack.relev === memo.maxRelev) {
                memo.maxStacks.push(targetStack);
            } else if (memo.maxStacks.length < limit) {
                memo.stacks.push(targetStack);
            }
        }

        // Recurse to next level
        if (phrasematchResults[idx + 1] !== undefined) {
            stackable(phrasematchResults, limit, memo, idx + 1, targetMask, targetNmask, targetStack, targetStack.relev, targetStack.adjRelev);
        }
    }

    if (idx === 0) {
        const stacks = memo.stacks.concat(memo.maxStacks);
        for (const stack of stacks) {
            // this will hyperbolically scale from 1 asymptotically down to .9
            const lengthPenalty = .9 + (.1 / (stack.length || 1));
            stack.adjRelev *= lengthPenalty;
        }
        return stacks;
    }
}

/**
 * sortByRelevLengthIdx Sorts the stacks according to the scorefactor, relevance or length
 *
 * @param {object} a - Phrasematch archetype
 * @param {object} b - Phrasematch archetype
 * @returns {number} sort order
 */
function sortByRelevLengthIdx(a, b) {
    const first = (b.adjRelev - a.adjRelev) ||
        (a.length - b.length) ||
        (b.relev - a.relev) ||
        (b[b.length - 1].proxMatch - a[a.length - 1].proxMatch) ||
        (b[b.length - 1].catMatch - a[a.length - 1].catMatch) ||
        (b[b.length - 1].scorefactor - a[a.length - 1].scorefactor);
    if (first) return first;

    for (let end = a.length - 1; end >= 0; end--) {
        const second = a[end].idx - b[end].idx;
        if (second) return second;
    }
}

/**
 * sortByZoomIdx Sorts stacks by zoom level
 *
 * @param {object} a - Phrasematch stack
 * @param {object} b - Phrasematch stack
 * @returns {number} sort order
 */
function sortByZoomIdx(a, b) {
    return (a.zoom - b.zoom) || (a.idx - b.idx) || (b.mask - a.mask);
}

/**
 * sortByRelev spatialmatches by relevance
 *
 * @param {object} a - Spatialmatch
 * @param {object} b - Spatialmatch
 * @returns {number} sort order
 */
function sortByRelev(a, b) {
    return (b.relev - a.relev) ||
        (b.scoredist - a.scoredist) ||
        (a.covers[0].idx - b.covers[0].idx) ||
        (b.address ? 1 : 0) - (a.address ? 1 : 0);
}

/**
 * rebalance recalculates the relevance based on the number of tokens and number of layers that match in the result and query
 *
 * Rebalancing is done to prevent cases where the number of tokens causes the relevance to cause an index to win
 * over an index that actually has the feature
 * For example: Martin Luther King Jr. Street, Thanjavur, Tamil Nadu would return an American city
 * since Martin Luther King Jr. Street is a really long street name
 * any result that contains the street(like Martin Luther King Jr. Street, Washington, DC would automatically have a higher relevance.
 *
 * @param {Array} query a list of terms composing the query to Carmen
 * @param {Array} stack results for a subquery combination
 * @returns {Array} - rebalanced stack
 */
function rebalance(query, stack) {
    let stackMask = 0;
    const stackClone = [];

    for (let i = 0; i < stack.length; i++) {
        stackMask |= stack[i].mask;
    }

    const garbage = (query.length === (stackMask.toString(2).split(1).length - 1)) ? 0 : 1;
    const totalLengthBonus = .01 * (garbage + stack.length);
    const weightPerMatch = (1 / (garbage + stack.length)) - 0.01;

    // shallow copy stack into stackClone to prevent cases where a stack's
    // index gets overwritten in deep copies.
    let totalWeight = 0;
    for (let k = 0; k < stack.length; k++) {
        stackClone[k] = stack[k].clone();
        stackClone[k].weight = roundTo((
            weightPerMatch +
            (totalLengthBonus * stack[k].weight)
        ) * stack[k].editMultiplier, 8);
        totalWeight += stackClone[k].weight;
    }

    stackClone.relev = Math.min(roundTo(totalWeight, 8), 1);

    return stackClone;
}

/**
 * Spatialmatch features of a stacks that could be stacked together spatially
 *
 * @constructor
 * @param {Object} cacheSpatialmatch - TODO
 * @param {Object} stackByIdx - TODO
 * @param {Object} addressDataByIdx - TODO
 * @param {Boolean} partialNumber - TODO
 */
function Spatialmatch(cacheSpatialmatch, stackByIdx, addressDataByIdx, partialNumber) {
    this.relev = cacheSpatialmatch.relev;
    this.covers = [];
    this.partialNumber = partialNumber || false;
    this.address = null;
    for (let i = 0; i < cacheSpatialmatch.length; i++) {
        const cacheCover = cacheSpatialmatch[i];
        this.covers.push(new Cover(cacheCover, stackByIdx.get(cacheCover.idx)));

        // just do this once, for the sake of determinism
        if (!this.address) {
            const addressMatch = addressDataByIdx.get(cacheCover.idx);
            if (addressMatch) this.address = addressMatch;
        }
    }
    this.scoredist = this.covers[0].scoredist;
    // this line artificially boosts scoredist for nearby partial-number matches
    // from address indexes, which may not have an informative score that would
    // otherwise allow them to be surfaced; the specific multiplier was determined
    // by trial and error and ideally, we'd come up with a way to tackle this in
    // a less hacky way
    if (this.partialNumber) this.scoredist *= 300;
}

/**
 * Tile Cover of a phrasematch
 *
 * @constructor
 * @param {Object} cacheCover - TODO
 * @param {Object} phrasematch - TODO
 */
function Cover(cacheCover, phrasematch) {
    this.x = cacheCover.x;
    this.y = cacheCover.y;
    this.relev = cacheCover.relev;
    this.id = cacheCover.id;
    this.idx = cacheCover.idx;
    this.tmpid = cacheCover.tmpid;
    this.distance = cacheCover.distance;
    this.score = termops.decode3BitLogScale(cacheCover.score, phrasematch.scorefactor);
    this.scoredist = cacheCover.scoredist > 7 ? (phrasematch.scorefactor / 7) * cacheCover.scoredist : termops.decode3BitLogScale(cacheCover.scoredist, phrasematch.scorefactor);
    this.scorefactor = phrasematch.scorefactor;
    this.matches_language = cacheCover.matches_language;
    this.prefix = phrasematch.prefix;

    this.mask = phrasematch.mask;
    this.text = phrasematch.subquery.join(' ');
    this.zoom = phrasematch.zoom;
}
