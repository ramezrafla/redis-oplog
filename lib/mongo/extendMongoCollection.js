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

const caches = []

export default () => {
  const proto = Mongo.Collection.prototype

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
      if (!this._isCached || !doc || !doc._id) return
      const key = doc._id
      this.cache.set(key, EJSON.clone(doc))
      this.lastAccess.set(key, getTime())
    },

    getCache(id) {
      if (!this._isCached) return
      const doc = this.cache.get(id)
      if (doc) {
        this.lastAccess.set(id, getTime())
        ++this._hits
        return EJSON.clone(doc)
      }
      ++this._misses
      return undefined
    },

    hasCache(id) {
      if (!this._isCached) return false
      const result = this.cache.has(id)
      if (result) {
        ++this._hits
        this.lastAccess.set(id, getTime())
      }
      else {
        ++this._misses
      }
      return result
    },

    deleteCache(doc) {
      if (!this._isCached) return
      var id = typeof doc === 'string' ? doc : doc._id
      this.cache.delete(id)
      this.lastAccess.delete(id)
    },

    startCaching(timeout) {
      this._isCached = true
      this._hits = 0
      this._misses = 0
      this.cache = new Map()
      this.lastAccess = new Map()
      caches.push({name:this._name, cache:this.cache, lastAccess:this.lastAccess, timeout:timeout || Config.cacheTimeout})

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
          const keys = this.cache.keys()
          var key = keys.next().value
          var found = false
          while (key && !found) {
            // we access cache directly to avoid wasteful cloning
            doc = this.cache.get(key)
            found = matcher.documentMatches(doc).result
            if (!found) key = keys.next().value
          }
          if (found) {
            ++this._hits
            // we got the doc straight from the cache --> need to clone it
            doc = EJSON.clone(doc)
            this.lastAccess.set(key, getTime())
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
    },

    clearCache(selector) {
      if (!selector || (_.isObject(selector) && _.isEmpty(selector))) {
        this.cache.clear()
        this.lastAccess.clear()
      }
      else {
        const matcher = new Minimongo.Matcher(selector)
        const keys = this.cache.keys()
        var key = keys.next().value
        var doc
        while (key) {
          // we access cache directly to avoid wasteful cloning
          doc = this.cache.get(key)
          if (matcher.documentMatches(doc).result) {
            this.cache.delete(key)
            this.lastAccess.delete(key)
          }
          key = keys.next().value
        }
      }
    }

  })
}

const onTimer = function() {
  const now = getTime()
  caches.forEach(({cache, lastAccess, timeout, name}) => {
    if (DEBUG_SHOW && cache.size) console.log(cache)
    lastAccess.forEach((date, key) => {
      if (now - date > timeout) {
        DEBUG && console.log('Mongo - clearing: ' + name + ' ' + key)
        cache.delete(key)
        lastAccess.delete(key)
      }
    })
  })
}

const getTime = function() {
  return (new Date()).getTime()
}
