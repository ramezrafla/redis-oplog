import { Mongo } from 'meteor/mongo'
import { _ } from 'meteor/underscore'
import Mutator from './Mutator'
import extendObserveChanges from './extendObserveChanges'
import { Meteor } from 'meteor/meteor'
import { EJSON } from 'meteor/ejson'
import { Minimongo, LocalCollection } from 'meteor/minimongo'
import Config from '../config'

const DEBUG = (Meteor.isDevelopment || Meteor.isStaging) && true
const DEBUG_SHOW = DEBUG && false
var DELAY
// 30 mins data retention

const cache = new Map()
const lastAccess = new Map()

export default () => {
  const proto = Mongo.Collection.prototype

  const Originals = {
    insert: proto.insert,
    update: proto.update,
    remove: proto.remove,
    find: proto.find,
    findOne: proto.findOne,
  }

  // to give config the chance to get value from user settings
  DELAY = Config.cacheTimer
  Meteor.setInterval(onTimer, DELAY / 4)

  extendObserveChanges()

  _.extend(proto, {
    /**
         * @param data
         * @param config
         * @returns {*}
         */
    insert(data, config) {
      return Mutator.insert.call(this, Originals, data, config)
    },

    /**
         * @param selector
         * @param modifier
         * @param config
         * @param callback
         * @returns {*}
         */
    update(selector, modifier, config, callback) {
      return Mutator.update.call(
        this,
        Originals,
        selector,
        modifier,
        config,
        callback
      )
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
      if (!this._isCached || !doc || !doc._id) return
      const key = this._prefix + doc._id
      cache.set(key, EJSON.clone(doc))
      lastAccess.set(key, getTime())
    },

    getCache(id) {
      if (!this._isCached) return
      const key = this._prefix + id
      const doc = cache.get(key)
      if (doc) {
        lastAccess.set(key, getTime())
        ++this._hits
        return EJSON.clone(doc)
      }
      ++this._misses
      return undefined
    },

    hasCache(id) {
      if (!this._isCached) return false
      const key = this._prefix + id
      const result = cache.has(key)
      if (result) {
        ++this._hits
        lastAccess.set(key, getTime())
      }
      else {
        ++this._misses
      }
      return result
    },

    deleteCache(doc) {
      if (!this._isCached) return
      var id = typeof doc === 'string' ? doc : doc._id
      const key = this._prefix + id
      cache.delete(key)
      lastAccess.delete(key)
    },

    startCaching() {
      this._isCached = true
      this._prefix = this._name + '-'
      this._hits = 0
      this._misses = 0
      // note: we have to clone docs as we are accessing the cache directly
      this.findOne = function(selector, options) {
        var doc
        var id
        if (typeof selector == 'string') id = selector
        else if (_.isObject(selector) && typeof selector._id == 'string') id = selector._id
        if (id) {
          doc = this.getCache(id)
        }
        else {
          const matcher = new Minimongo.Matcher(selector)
          const keys = cache.keys()
          var key = keys.next().value
          var found = false
          while (key && !found) {
            if (key.indexOf(this._prefix) == 0) {
              doc = cache.get(key)
              found = matcher.documentMatches(doc).result
            }
            if (!found) key = keys.next().value
          }
          if (found) {
            ++this._hits
            // we got the doc straight from the cache --> need to clone it
            doc = EJSON.clone(doc)
            lastAccess.set(key, getTime())
          }
          else {
            doc = undefined
          }
        }
        if (!doc) {
          doc = Originals.findOne.call(this, selector, { ...options, fields:{}})
          if (!doc) return undefined
          ++this._misses
          this.setCache(doc)
        }
        if (options?.fields) {
          try {
            const projector = LocalCollection._compileProjection(options.fields)
            return projector(doc)
          }
          catch(e) { }
        }
        return doc
      }
    },

    fetchInCacheFirst(ids, options) {
      if (!this._isCached) return Originals.find.call(this, {_id:{$in:ids}}, options).fetch()
      var result = []
      const notFoundIds = []
      ids.forEach((id) => {
        const doc = this.getCache(id)
        if (doc) result.push(doc)
        else notFoundIds.push(id)
      })
      if (notFoundIds.length) {
        const findOptions = {...options, fields:{}}
        const newResult = _.compact(Originals.find.call(this, {_id:{$in:notFoundIds}}, findOptions).fetch())
        newResult.forEach((doc) => this.setCache(doc))
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

    // this function adds to cache docs already not there, and replaces any existing docs with the ones from the cache
    mergeDocs(docs) {
      if (!this._isCached) return
      _.each(_.compact(docs), (doc, index) => {
        const cache = this.getCache(doc._id)
        if (cache) docs[index] = cache
        else this.setCache(doc)
      })
    },

    disableRedis() {
      this._skipRedis = true
    }
  })
}

const onTimer = function() {
  const now = getTime()
  if (DEBUG_SHOW && cache.size) console.log(cache)
  lastAccess.forEach((date, key) => {
    if (now - date > DELAY) {
      DEBUG && console.log('Mongo - clearing ' + key)
      cache.delete(key)
      lastAccess.delete(key)
    }
  })
}

const getTime = function() {
  return (new Date()).getTime()
}

export const getCache = function(collection, id) {
  const key = collection + '-' + id
  const value = cache.get(key)
  if (value) lastAccess.set(key, getTime())
  return value
}
