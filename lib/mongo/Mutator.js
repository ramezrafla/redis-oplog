import getMutationConfig from './lib/getMutationConfig'
import getFields from '../utils/getFields'
import { dispatchInsert, dispatchUpdate, dispatchRemove } from './lib/dispatchers'
import { _ } from 'meteor/underscore'
import { Meteor } from 'meteor/meteor'
import { Mongo } from 'meteor/mongo'
import { LocalCollection } from 'meteor/minimongo'
import DeepDiff from './lib/DeepDiff'
import { EJSON } from 'meteor/ejson'

function runCallbackInBackground(fn) {
  Meteor.defer(Meteor.bindEnvironment(fn))
}

/**
 * The Mutator is the interface that does the required updates
 */
export default class Mutator {
  static insert(Originals, data, _config) {
    const config = getMutationConfig(this, _config)

    try {
      const docId = Originals.insert.call(this, data)
      const doc = { ...data, _id:docId }
      this.setCache(doc)

      // the callback is not handled in the insert above
      if (typeof _config === 'function') runCallbackInBackground(() => _config.call(this, null, docId))

      if (!this._skipRedis && config.pushToRedis) dispatchInsert(
        config.optimistic,
        this._name,
        config._channels,
        doc
      )

      return docId
    }
    catch (e) {
      if (typeof _config === 'function') runCallbackInBackground(() => _config.call(this, e))
      throw e
    }
  }

  /**
     * @param Originals
     * @param selector
     * @param modifier
     * @param _config
     * @param callback
     * @returns {*}
     */
  static update(Originals, selector, modifier, _config, callback) {
    if (typeof selector === 'string') selector = { _id: selector }

    if (typeof _config === 'function') {
      callback = _config
      _config = {}
    }

    const config = getMutationConfig(this, _config)

    // searching the elements that will get updated by id
    // note: we get all the fields so we can update our local cache
    const findOptions = { transform: null }
    if (!config.multi) findOptions.limit = 1

    var docIds
    var docs
    if (selector && selector._id && _.keys(selector).length == 1) {
      docIds = typeof selector._id === 'string' ? [selector._id] : _.isObject(selector._id) && selector._id.$in ? selector._id.$in : null
      if (docIds != null && docIds.length == 0) return 0
    }
    if (!docIds) {
      docs = this.find(selector, findOptions).fetch()
      this.mergeDocs(docs)
      docIds = docs.map((doc) => doc._id)
    }
    if (!docs && docIds && docIds.length) {
      docs = this.fetchInCacheFirst(docIds, findOptions)
    }
    if (!docs) docs = []

    if (config.upsert) return Mutator.handleUpsert.call(
      this,
      Originals,
      selector,
      modifier,
      config,
      callback,
      docIds,
      docs
    )

    if (docs.length == 0) {
      if (callback) runCallbackInBackground(() => callback.call(this, null, 0))
      return 0
    }

    // we do this because when we send to redis
    // we need the exact _ids
    // and we extend the selector, because if between finding the docIds and updating
    // another matching insert sneaked in, its update will not be pushed

    try {
      // we do this because when we send to redis
      // we need the exact _ids
      // and we extend the selector, because if between finding the docIds and updating
      // another matching insert sneaked in, its update will not be pushed
      const updateSelector = _.extend({}, selector, {_id: { $in: docIds } })

      const result = config.skipDB ? 0 : Originals.update.call(
        this,
        updateSelector,
        modifier,
        config
      )

      // let's update all the docs locally - avoids race conditions too
      // we do this after the DB update in case of errors
      docs.forEach((before, index) => {
        const after = EJSON.clone(before)
        LocalCollection._modify(after, modifier)
        const diff = DeepDiff(before, after)
        if (diff) {
          this.setCache(after)
          const fieldsToKeep = _.map(diff, (d) => d.path && d.path[0])
          docs[index] = _.pick(after, [...fieldsToKeep, '_id'])
          // console.log('Update:', modifier, before, after, docs[index])
        }
        // nothing to change -- get rid of it
        else delete docs[index]
      })

      // we run the callback after we call the DB in case there is an error
      if (callback) runCallbackInBackground(() => callback.call(this, null, result))

      if (this._skipRedis || !config.pushToRedis || docs.length == 0) return result

      const { topLevelFields } = getFields(modifier)
      const pickFields = [...topLevelFields, '_id']
      docs = docs.map((doc) => _.pick(doc, pickFields))

      dispatchUpdate(
        config.optimistic,
        this._name,
        config._channels,
        docs,
        topLevelFields
      )

      return result
    }
    catch (e) {
      if (callback) runCallbackInBackground(() => callback.call(this, e))
      else throw e
    }
  }

  /**
     * @param Originals
     * @param selector
     * @param modifier
     * @param config
     * @param callback
     * @param docIds
     */
  static handleUpsert(
    Originals,
    selector,
    modifier,
    config,
    callback,
    docIds,
    docs
  ) {
    try {
      const result = Originals.update.call(
        this,
        selector, // we can't use docIds as selector as we are not sure yet if it's an insert or an update -- let the db handle it
        modifier,
        // config already includes upsert:true
        // _returnObject is internal to meteor:mongo
        _.extend({}, config, { _returnObject: true })
      )

      var doc

      // inserted
      if (result.insertedId) {

        // trying to guess the document
        if (modifier.$set && typeof selector == 'object') {
          doc = { ...selector, ...modifier.$set, _id:result.insertedId }
        }
        // we shouldn't be here -- fallback just in case
        // prone to race conditions in secondary-read environment
        else {
          docs = this.find(result.insertedId).fetch()
          doc = docs && docs.length && docs[0]
        }

        // if the doc was successfully inserted we know it should be cached
        this.setCache(doc)

        // we run the callback after our cache is updated
        if (callback) runCallbackInBackground(() => callback.call(this, null, result))

        if (!this._skipRedis && config.pushToRedis) dispatchInsert(
          config.optimistic,
          this._name,
          config._channels,
          doc
        )
      }

      // updated
      else {

        // it means that we ran an upsert thinking there will be no docs
        if (docIds.length === 0 || result.numberAffected !== docIds.length) {
          // there were no docs initially found matching the selector
          // however a document sneeked in, resulting in a race-condition
          // and if we look again for that document, we cannot retrieve it.

          // or a new document was added/modified to match selector before the actual update
          console.warn('RedisOplog - Warning - A race condition occurred when running upsert.')
        }
        else {
          //////////////// copied from update above

          // let's update all the docs locally - avoids race conditions too
          docs.forEach((before, index) => {
            const after = EJSON.clone(before)
            LocalCollection._modify(after, modifier)
            const diff = DeepDiff(before, after)
            if (diff) {
              this.setCache(after)
              const fieldsToKeep = _.map(diff, (d) => d.path && d.path[0])
              docs[index] = _.pick(after, [...fieldsToKeep, '_id'])
              // console.log('Update:', modifier, before, after, docs[index])
            }
            // nothing to change -- get rid of it
            else delete docs[index]
          })

          // we run the callback after our cache is updated
          if (callback) runCallbackInBackground(() => callback.call(this, null, result))

          if (!this._skipRedis && config.pushToRedis) {
            const { topLevelFields } = getFields(modifier)
            const pickFields = [...topLevelFields, '_id']
            docs = docs.map((doc) => _.pick(doc, pickFields))

            dispatchUpdate(
              config.optimistic,
              this._name,
              config._channels,
              docs,
              topLevelFields
            )
          }
        }
      }

      return result
    }
    catch (e) {
      if (callback) runCallbackInBackground(() => callback.call(this, e))
      else throw e
    }
  }

  /**
     * @param Originals
     * @param selector
     * @param _config
     * @returns {*}
     */
  static remove(Originals, selector, _config) {
    // this is to protect against accidentally clearing the whole db with a 'falsey' id
    selector = Mongo.Collection._rewriteSelector(selector)
    const config = getMutationConfig(this, _config)

    var docIds, docs
    if (selector && selector._id && _.keys(selector).length == 1) {
      docIds = typeof selector._id === 'string' ? [selector._id] : _.isObject(selector._id) && selector._id.$in ? selector._id.$in : null
      docs = docIds.map((_id) => ({_id}))
    }
    if (!docIds) {
      // no point in storing, these docs will be removed
      docs = this.find(selector, { fields: { _id: 1 }, transform: null }).fetch()
      docIds = docs.map((doc) => doc._id)
    }

    // nothing to remove
    if (!docs || docIds.length === 0) {
      if (typeof _config === 'function') runCallbackInBackground(() => _config.call(this, null, 0))
      return 0
    }

    try {
      const result = Originals.remove.call(this, {_id: { $in: docIds }})

      docIds.forEach((id) => this.deleteCache(id))

      // we run the callback after we call the DB in case there is an error
      if (typeof _config === 'function') runCallbackInBackground(() => _config.call(this, null, result))

      if (!this._skipRedis && config.pushToRedis) dispatchRemove(
        config.optimistic,
        this._name,
        config._channels,
        docs
      )

      return result
    }
    catch (e) {
      if (typeof _config === 'function') runCallbackInBackground(() => _config.call(this, e))
      else throw e
    }
  }
}
