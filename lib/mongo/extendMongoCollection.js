import { Mongo } from 'meteor/mongo'
import { _ } from 'meteor/underscore'
import Mutator from './Mutator'
import extendObserveChanges from './extendObserveChanges'
import { Meteor } from 'meteor/meteor'
import { EJSON } from 'meteor/ejson'
import { Minimongo, LocalCollection } from 'meteor/minimongo'
import Config from '../config'

const DEBUG = (Meteor.isDevelopment || Meteor.isStaging) && false
const DEBUG_SHOW = DEBUG && true

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
    insert(doc, config) {
      return Mutator.insert.call(this, Originals, doc, config)
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
      this._cache.set(key, EJSON.clone(doc))
      this._lastAccess.set(key, getTime())
    },

    getCache(id) {
      if (!this._isCached) return
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
      if (!this._isCached) return false
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
      if (!this._isCached) return
      var id = typeof doc === 'string' ? doc : doc._id
      this._cache.delete(id)
      this._lastAccess.delete(id)
    },

    startCaching(timeout) {
      this._isCached = true
      this._hits = 0
      this._misses = 0
      this._cache = new Map()
      this._lastAccess = new Map()
      caches.push({name:this._name, cache:this._cache, lastAccess:this._lastAccess, timeout:timeout || Config.cacheTimeout})

      // note: we have to clone docs as we are accessing the cache directly
      this.findOne = function(selector = {}, options) {
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

      this.direct = {
        insert: (doc, config) => Mutator.insert.call(this, Originals, doc, config),
        update: (selector, modifier, config, callback) => Mutator.update.call(this, Originals, selector, modifier, config, callback),
        remove: (selector, config) => Mutator.remove.call(this, Originals, selector, config)
      }

      this.before = {
        insert: (func) => {
          if (!this._beforeInsertHooks) {
            this._beforeInsertHooks = []
            this._afterInsertHooks = []
            this.insert = (data, config) => {
              const userId = getUserId()
              _.each(this._beforeInsertHooks, (func) => func.call(null, userId, data))
              const _id = Mutator.insert.call(this, Originals, data, config)
              _.each(this._afterInsertHooks, (func) => func.call({ _id }, userId, data))
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
              const docs = config && config.multi ? this.find(selector, config && config.multi ? {multi:true} : null).fetch() : [ this.findOne(selector) ]
              if (docs.length == 0 || docs[0] == null) return
              const userId = getUserId()
              const fields = getFields(modifier)
              _.each(this._beforeUpdateHooks, (func) => docs.forEach((doc) => func.call(null, userId, doc, fields, modifier, config)))
              const result = Mutator.update.call(this, Originals, selector, modifier, config, callback)
              _.each(this._afterUpdateHooks, (func) => docs.forEach((doc) => func.call({previous:doc}, userId, this.findOne(doc._id), fields, modifier, config)))
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
              const docs = this.find(selector, config).fetch()
              if (docs.length == 0) return
              _.each(this._beforeRemoveHooks, (func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              const result = Mutator.remove.call(this, Originals, selector, config)
              _.each(this._afterRemoveHooks, (func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              return result
            }
          }
          this._beforeRemoveHooks.push(func)
        }
      }

      this.after = {
        insert: (func) => {
          if (!this._beforeInsertHooks) {
            this._beforeInsertHooks = []
            this._afterInsertHooks = []
            this.insert = (data, config) => {
              const userId = getUserId()
              _.each(this._beforeInsertHooks, (func) => func.call(null, userId, data))
              const _id = Mutator.insert.call(this, Originals, data, config)
              _.each(this._afterInsertHooks, (func) => func.call({ _id }, userId, data))
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
              const docs = config && config.multi ? this.find(selector, config && config.multi ? {multi:true} : null).fetch() : [ this.findOne(selector) ]
              if (docs.length == 0 || docs[0] == null) return
              const userId = getUserId()
              const fields = getFields(modifier)
              _.each(this._beforeUpdateHooks, (func) => docs.forEach((doc) => func.call(null, userId, doc, fields, modifier, config)))
              const result = Mutator.update.call(this, Originals, selector, modifier, config, callback)
              _.each(this._afterUpdateHooks, (func) => docs.forEach((doc) => func.call({previous:doc}, userId, this.findOne(doc._id), fields, modifier, config)))
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
              const docs = this.find(selector, config).fetch()
              if (docs.length == 0) return
              _.each(this._beforeRemoveHooks, (func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              const result = Mutator.remove.call(this, Originals, selector, config)
              _.each(this._afterRemoveHooks, (func) => docs.forEach((doc) => func.call(null, userId, doc, config)))
              return result
            }
          }
          this._afterRemoveHooks.push(func)
        }
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


const getUserId = function() {
  try {
    return Meteor.userId && Meteor.userId()
  }
  catch (e) {}
  return null
}

function getFields(mutator) {
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
