import { Mongo } from 'meteor/mongo'
import { _ } from 'meteor/underscore'
import Mutator from './mutator'
import extendObserveChanges from './extendObserveChanges'
import { Meteor } from 'meteor/meteor'
import { EJSON } from 'meteor/ejson'
import { Minimongo, LocalCollection } from 'meteor/minimongo'
import Config from '../config'
import { setFieldsToIgnore } from '../redis/raceDetectionManager'
import { isIdSelector, getIdsFromSelector } from './lib/idSelector'
import { addToWatch, removeFromWatch } from '../redis/watchManager'

const DEBUG_CACHE = (Meteor.isDevelopment || Meteor.isStaging) && true
const DEBUG_SHOW = (Meteor.isDevelopment || Meteor.isStaging) && false

const caches = []

export default () => {
  const proto = Mongo.Collection.prototype

  // methods before overloading
  const Originals = {
    insert: proto.insert,
    update: proto.update,
    remove: proto.remove,
    find: proto.find,
    findOne: proto.findOne,
  }

  Meteor.setInterval(onTimer, Config.cacheTimer)

  extendObserveChanges()

  _.extend(proto, {

    // to speed things up instead of !_isCached
    _isNotCached: true,

    /**
         * @param data
         * @param config
         * @returns {*}
         */
    insert(doc, config) {
      return Mutator.insert.call(this, Originals, doc, config)
    },

    rawFindOne(selector, options) {
      return Originals.findOne.call(this, selector, options)
    },

    /**
         * @param selector
         * @param modifier
         * @param config
         * @param callback
         * @returns {*}
         */
    update(selector, modifier, config, callback) {
      return Mutator.update.call(this, Originals, selector, modifier, config, callback)
    },

    /**
         * @param selector
         * @param config
         * @returns {*}
         */
    remove(selector, config) {
      return Mutator.remove.call(this, Originals, selector, config)
    },

    setCache(doc) {
      if (this._isNotCached || !doc || !doc._id) return
      const id = doc._id
      if (!this._cache.has(id)) addToWatch(this._name, id)
      this._cache.set(id, EJSON.clone(doc))
      this._lastAccess.set(id, getTime())
    },

    getCache(id) {
      if (this._isNotCached) return
      // console.log('getCache', id)
      const doc = this._cache.get(id)
      if (doc) {
        this._lastAccess.set(id, getTime())
        ++this._hits
        return EJSON.clone(doc)
      }
      ++this._misses
      return undefined
    },

    hasCache(id) {
      if (this._isNotCached) return false
      const result = this._cache.has(id)
      if (result) {
        ++this._hits
        this._lastAccess.set(id, getTime())
      }
      else {
        ++this._misses
      }
      return result
    },

    deleteCache(doc) {
      if (this._isNotCached) return
      var id = typeof doc === 'string' ? doc : doc._id
      removeFromWatch(this._name, id)
      this._cache.delete(id)
      this._lastAccess.delete(id)
    },

    addSub(id) {
      if (this._isNotCached) return
      if (!this._subs[id]) this._subs[id] = 1
      else ++this._subs[id]
      DEBUG_CACHE && console.log('addSub ' + this._name + ': ' + id + ' (' + this._subs[id] + ')')
    },

    removeSub(id) {
      if (this._isNotCached) return
      if (this._subs[id]) {
        --this._subs[id]
        DEBUG_CACHE && console.log('removeSub ' + this._name + ': ' + id + ' (' + this._subs[id] + ')')
      }
    },

    startCaching(timeout) {
      this._isNotCached = false
      this._subs = { }
      this._hits = 0
      this._misses = 0
      this._cache = new Map()
      this._lastAccess = new Map()
      caches.push({
        name:this._name,
        cache:this._cache,
        lastAccess:this._lastAccess,
        subs: this._subs,
        timeout: timeout || Config.cacheTimeout
      })

      // note: we have to clone docs as we are accessing the cache directly
      const findOne = (selector = {}, options = {}) => {
        var doc
        var id
        if (typeof selector == 'string') id = selector
        else if (_.isObject(selector) && typeof selector._id == 'string') id = selector._id
        if (id) {
          doc = this.getCache(id)
        }
        else {
          const matcher = new Minimongo.Matcher(selector)
          const keys = this._cache.keys()
          var key = keys.next().value
          var found = false
          while (key && !found) {
            // we access cache directly to avoid wasteful cloning
            doc = this._cache.get(key)
            found = matcher.documentMatches(doc).result
            if (!found) key = keys.next().value
          }
          if (found) {
            ++this._hits
            // we got the doc straight from the cache --> need to clone it
            doc = EJSON.clone(doc)
            this._lastAccess.set(key, getTime())
          }
          else {
            doc = undefined
          }
        }
        if (!doc) {
          doc = Originals.findOne.call(this, selector, options.skipSave ? options : _.omit(options, 'fields'))
          if (!doc) return undefined
          DEBUG_CACHE && console.log('findOne: Fetched from DB ' + this._name + ' ' + doc._id)
          ++this._misses
          if (!options.skipSave) this.setCache(doc)
        }
        if (options.fields) {
          try {
            const projector = LocalCollection._compileProjection(options.fields)
            return projector(doc)
          }
          catch(e) { }
        }
        return doc
      }
      this.findOne = findOne


      // we need to override find too in order to fetch from cache (and save docs we get)
      // otherwise we are still hitting the DB and we WILL hit race conditions if reading from secondaries
      const find = (selector = {}, options = {}) => {
        // we need to save original options for observeChanges to pass it on to the multiplexer
        if (options.fields) options._fields = options.fields
        // we need to return a Cursor otherwise downstream checks will trigger error
        const cursor = Originals.find.call(this, selector, options.skipSave ? options : _.omit(options, 'fields'))
        // we have 2 distinct cases
        // 1. either we are doing a select by _id (including {$in:[...]}) -- in which case it is deterministic and we can handle it ourselves
        // IMPORTANT: We don't support limit, skip and sort yet in this option
        if (isIdSelector(selector)) {
          const ids = getIdsFromSelector(selector)
          cursor.map = (cb, _this) => this.fetchInCacheFirst(ids, options).map(_this ? cb.bind(_this) : cb)
          cursor.forEach = (cb, _this) => this.fetchInCacheFirst(ids, options).forEach(_this ? cb.bind(_this) : cb)
          cursor.fetch = () => this.fetchInCacheFirst(ids, options)
          cursor.count = () => this.fetchInCacheFirst(ids, options).length
        }
        // 2. or it's a generic selector and we need help from the DB
        // we could do some optimizations here (for instance, edge cases where the cache satisfies our needs) but doesn't seem worthwhile at the moment
        else {
          const projector = options.fields ? LocalCollection._compileProjection(options.fields) : null
          var overrideCB
          if (options.skipSave) overrideCB = (cb, _this) => {
            if (_this) cb.bind(_this)
            return (doc) => {
              // cache ALWAYS overrules
              if (this.hasCache(doc._id)) {
                doc = this.getCache(doc._id)
                if (projector) {
                  try { doc = projector(doc) }
                  catch(e) { }
                }
              }
              return cb(doc)
            }
          }
          else overrideCB = (cb, _this) => {
            if (_this) cb.bind(_this)
            return (doc) => {
              // cache ALWAYS overrules
              if (this.hasCache(doc._id)) doc = this.getCache(doc._id)
              // any doc we touch, we have to save it
              else {
                DEBUG_CACHE && console.log('find: Fetched from DB ' + this._name + ' ' + doc._id)
                this.setCache(doc)
              }
              if (projector) {
                try { doc = projector(doc) }
                catch(e) { }
              }
              return cb(doc)
            }
          }
          // we have to unfortunately override all the methods, as we don't know which the user will call
          // observeChanges is globally overriden so we don't have to worry about it
          // map
          const origMap = cursor.map
          cursor.map = (cb, _this) => origMap.call(cursor, overrideCB(cb, _this))
          // forEach
          const origForEach = cursor.forEach
          cursor.forEach = (cb, _this) => origForEach.call(cursor, overrideCB(cb, _this))
          // fetch
          const origFetch = cursor.fetch
          cursor.fetch = (cb, _this) => origFetch.call(cursor, overrideCB(cb, _this))
          // count
          cursor.count = () => cursor.fetch().length
        }
        return cursor
      }
      this.find = find

      //////////////////// hooks to mimic collection-hooks

      // methods AFTER overloading done above
      this.direct = {
        find,
        findOne,
        insert: (doc, config) => proto.insert.call(this, doc, config),
        update: (selector, modifier, config, callback) => proto.update.call(this, selector, modifier, config, callback),
        remove: (selector, config) => proto.remove.call(this, selector, config)
      }


      ////// before

      this.before = {
        find: (func) => {
          if (!this._beforeFindHooks) {
            this._beforeFindHooks = []
            this._afterFindHooks = []
            this.find = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.find(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
            this.findOne = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.findOne(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
          }
          this._beforeFindHooks.push(func)
        },
        findOne: (func) => {
          if (!this._beforeFindHooks) {
            this._beforeFindHooks = []
            this._afterFindHooks = []
            this.find = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.find(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
            this.findOne = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.findOne(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
          }
          this._beforeFindHooks.push(func)
        },
        insert: (func) => {
          if (!this._beforeInsertHooks) {
            this._beforeInsertHooks = []
            this._afterInsertHooks = []
            this.insert = (data, config) => {
              const userId = getUserId()
              this._beforeInsertHooks.forEach((func) => func.call(null, userId, data))
              const _id = this.direct.insert(data, config)
              data._id = _id
              this._afterInsertHooks.forEach((func) => func.call({ _id }, userId, data))
              return _id
            }
          }
          this._beforeInsertHooks.push(func)
        },
        update: (func) => {
          if (!this._beforeUpdateHooks) {
            this._beforeUpdateHooks = []
            this._afterUpdateHooks = []
            this.update = (selector, modifier, config, callback) => {
              const docs = config?.multi ? this.direct.find(selector, config).fetch() : [ this.direct.findOne(selector) ]
              if (docs.length == 0 || docs[0] == null) return
              const userId = getUserId()
              const fields = getFields(modifier)
              this._beforeUpdateHooks.forEach((func) => docs.forEach((doc) => func.call(null, userId, doc, fields, modifier, config)))
              const result = this.direct.update(selector, modifier, config, callback)
              docs.forEach((previous) => {
                const after = this.direct.findOne(previous._id)
                this._afterUpdateHooks.forEach((func) => func.call({ previous }, userId, after, fields, modifier, config))
              })
              return result
            }
          }
          this._beforeUpdateHooks.push(func)
        },
        remove: (func) => {
          if (!this._beforeRemoveHooks) {
            this._beforeRemoveHooks = []
            this._afterRemoveHooks = []
            this.remove = (selector, config) => {
              const userId = getUserId()
              const docs = this.direct.find(selector, config).fetch()
              if (docs.length == 0) return
              this._beforeRemoveHooks.forEach((func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              const result = this.direct.remove(selector, config)
              this._afterRemoveHooks.forEach((func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              return result
            }
          }
          this._beforeRemoveHooks.push(func)
        }
      }


      ////// after

      this.after = {
        find: (func) => {
          if (!this._beforeFindHooks) {
            this._beforeFindHooks = []
            this._afterFindHooks = []
            this.find = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.find(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
            this.findOne = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.findOne(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
          }
          this._afterFindHooks.push(func)
        },
        findOne: (func) => {
          if (!this._beforeFindHooks) {
            this._beforeFindHooks = []
            this._afterFindHooks = []
            this.find = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.find(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
            this.findOne = (selector, options) => {
              this._beforeFindHooks.forEach((func) => func.apply(null, selector, options))
              const result = this.direct.findOne(selector, options)
              this._afterFindHooks.forEach((func) => func.apply(null, selector, options))
              return result
            }
          }
          this._afterFindHooks.push(func)
        },
        insert: (func) => {
          if (!this._beforeInsertHooks) {
            this._beforeInsertHooks = []
            this._afterInsertHooks = []
            this.insert = (data, config) => {
              const userId = getUserId()
              this._beforeInsertHooks.forEach((func) => func.call(null, userId, data))
              const _id = this.direct.insert(data, config)
              data._id = _id
              this._afterInsertHooks.forEach((func) => func.call({ _id }, userId, data))
              return _id
            }
          }
          this._afterInsertHooks.push(func)
        },
        update: (func) => {
          if (!this._beforeUpdateHooks) {
            this._beforeUpdateHooks = []
            this._afterUpdateHooks = []
            this.update = (selector, modifier, config, callback) => {
              const docs = config?.multi ? this.direct.find(selector, config).fetch() : [ this.direct.findOne(selector) ]
              if (docs.length == 0 || docs[0] == null) return
              const userId = getUserId()
              const fields = getFields(modifier)
              this._beforeUpdateHooks.forEach((func) => docs.forEach((doc) => func.call(null, userId, doc, fields, modifier, config)))
              const result = this.direct.update(selector, modifier, config, callback)
              docs.forEach((previous) => {
                const after = this.direct.findOne(previous._id)
                this._afterUpdateHooks.forEach((func) => func.call({ previous }, userId, after, fields, modifier, config))
              })
              return result
            }
          }
          this._afterUpdateHooks.push(func)
        },
        remove: (func) => {
          if (!this._beforeRemoveHooks) {
            this._beforeRemoveHooks = []
            this._afterRemoveHooks = []
            this.remove = (selector, config) => {
              const userId = getUserId()
              const docs = this.direct.find(selector, config).fetch()
              if (docs.length == 0) return
              this._beforeRemoveHooks.forEach((func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              const result = this.direct.remove(selector, config)
              this._afterRemoveHooks.forEach((func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              return result
            }
          }
          this._afterRemoveHooks.push(func)
        }
      }

      //////////////////// end of hooks

    },

    fetchInCacheFirst(ids, options = {}) {
      if (this._isNotCached) return Originals.find.call(this, {_id:{$in:ids}}, options).fetch()
      var result = []
      const notFoundIds = []
      ids.forEach((id) => {
        const doc = this.getCache(id)
        if (doc) result.push(doc)
        else notFoundIds.push(id)
      })
      if (notFoundIds.length) {
        const newResult = _.compact(Originals.find.call(this, {_id:{$in:notFoundIds}}, options.skipSave ? options : _.omit(options, 'fields')).fetch())
        DEBUG_CACHE && console.log('fetchInCacheFirst: Fetched from DB ' + this._name + ' ' + notFoundIds.join(','))
        if (!options.skipSave) newResult.forEach((doc) => this.setCache(doc))
        result = _.union(result, newResult)
      }
      if (options?.fields) {
        try {
          const projector = LocalCollection._compileProjection(options.fields)
          return result.map((doc) => projector(doc))
        }
        catch(e) { }
      }
      return result
    },

    disableRedis() {
      this._skipRedis = true
    },

    disableDiff() {
      this._skipDiff = true
    },

    raceFieldsToIgnore(fields) {
      setFieldsToIgnore(this._name, fields)
    },

    clearCache(selector) {
      if (!selector || (_.isObject(selector) && _.isEmpty(selector))) {
        this._cache.clear()
        this._lastAccess.clear()
      }
      else {
        const matcher = new Minimongo.Matcher(selector)
        const keys = this._cache.keys()
        var key = keys.next().value
        var doc
        while (key) {
          // we access cache directly to avoid wasteful cloning
          doc = this._cache.get(key)
          if (matcher.documentMatches(doc).result) {
            this._cache.delete(key)
            this._lastAccess.delete(key)
          }
          key = keys.next().value
        }
      }
    }

  })
}

const onTimer = function() {
  const now = getTime()
  caches.forEach(({cache, lastAccess, timeout, name, subs}) => {
    if (DEBUG_SHOW && cache.size) console.log(name + ':', cache)
    lastAccess.forEach((date, key) => {
      if (subs[key]) return
      if (now - date > timeout) {
        DEBUG_SHOW && console.log('RedisOplog - clearing: ' + name + ' ' + key)
        cache.delete(key)
        lastAccess.delete(key)
      }
    })
  })
}

export const getTime = function() {
  return (new Date()).getTime()
}


const getUserId = function() {
  try {
    return Meteor.userId && Meteor.userId()
  }
  catch (e) {}
  return null
}

const getFields = function(mutator) {
  // compute modified fields
  var fields = []
  _.each(mutator, function(params) {
    _.each(_.keys(params), function(field) {
      // top-level of dotted fields
      var index = field.indexOf('.')
      if (index !== -1) field = field.substring(0, index)
      fields.push(field)
    })
  })
  fields = _.uniq(fields)
  // if (DEBUG) Logger.log('CollectionHooks - getFields', fields)
  return fields
}


Meteor.methods({
  'RedisOplog.getCache': (key, collectionName, id) => {
    if (!Config.key && Config.key != key) throw new Meteor.Error('Wrong key')
    const cache = caches.filter((c) => c.name == collectionName)
    if (id) return cache[0].cache.get(id)
    return JSON.stringify(cache[0].cache)
  },
  'RedisOplog.deleteCache': (key, collectionName, id) => {
    if (!Config.key && Config.key != key) throw new Meteor.Error('Wrong key')
    const cache = caches.filter((c) => c.name == collectionName)
    cache[0].cache.delete(id)
    cache[0].cache.lastAccess(id)
  }
})
