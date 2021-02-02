import getMutationConfig from './lib/getMutationConfig'
import getFields from '../utils/getFields'
import { dispatchInsert, dispatchUpdate, dispatchRemove } from './lib/dispatchers'
import { _ } from 'meteor/underscore'
import { Meteor } from 'meteor/meteor'
import { Mongo } from 'meteor/mongo'
import { LocalCollection } from 'meteor/minimongo'
import DeepDiff from './lib/DeepDiff'
import { EJSON } from 'meteor/ejson'
import { Random } from 'meteor/random'

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
      var docId
      if (config.skipDB) docId = data._id || Random.id()
      else docId = Originals.insert.call(this, data)
      const doc = { ...data, _id:docId }
      this.setCache(doc)

      // the callback is not handled in the insert above
      if (typeof _config === 'function') runCallbackInBackground(() => _config.call(this, null, docId))

      if (!this._skipRedis && config.pushToRedis) dispatchInsert(config.optimistic, this._name, config._channels, doc)

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
    if (typeof _config === 'function') {
      callback = _config
      _config = {}
    }

    const config = getMutationConfig(this, _config)

    const findOptions = { transform: null }
    if (!config.multi) findOptions.limit = 1

    var docs = this.find(selector, findOptions).fetch()
    var docIds = docs.map((doc) => doc._id)
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

      // getting fields to $unset
      const cleared = modifier.$unset && _.keys(modifier.$unset) || []
      if (modifier.$set) _.each(modifier.$set, (value, key) => { if (value == null) cleared.push(key) })

      const { topLevelFields } = getFields(modifier)

      // let's update all the docs locally - reduces risk of race conditions too
      // we do this after the DB update in case of errors
      if (this._skipDiff || config.skipDiff) {
        const pickFields = [...topLevelFields, '_id']
        docs.forEach((before, index) => {
          LocalCollection._modify(docs[index], modifier)
          this.setCache(docs[index])
          docs[index] = _.pick(docs[index], pickFields)
        })
      }
      else {
        docs.forEach((before, index) => {
          const after = EJSON.clone(before)
          LocalCollection._modify(after, modifier)
          const diff = DeepDiff(before, after, true)
          if (diff) {
            this.setCache(after)
            docs[index] = _.pick(after, [...diff[0], '_id'])
          }
          // nothing to change -- get rid of it
          else delete docs[index]
        })
      }

      // we run the callback after we call the DB in case there is an error
      if (callback) runCallbackInBackground(() => callback.call(this, null, result))

      if (this._skipRedis || !config.pushToRedis || docs.length == 0) return result

      dispatchUpdate(
        config.optimistic,
        this._name,
        config._channels,
        docs,
        topLevelFields,
        cleared.length ? cleared : undefined
      )

      return config.skipDB ? docs.length : result
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
        if (typeof selector == 'string') {
          if (modifier.$set) doc = { ...modifier.$set, _id:result.insertedId }
          else doc = { ...modifier, _id:result.insertedId }
        }
        else if (typeof selector == 'object') {
          if (modifier.$set) doc = { ...selector, ...modifier.$set, _id:result.insertedId }
          else doc = { ...selector, ...modifier, _id:result.insertedId }
        }
        // we shouldn't be here -- fallback just in case
        // prone to race conditions in secondary-read environment
        else {
          doc = Originals.findOne.call(this, result.insertedId)
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

          const { topLevelFields } = getFields(modifier)

          // let's update all the docs locally - reduces risk of race conditions too
          // we do this after the DB update in case of errors
          if (this._skipDiff || config.skipDiff) {
            const pickFields = [...topLevelFields, '_id']
            docs.forEach((before, index) => {
              LocalCollection._modify(docs[index], modifier)
              this.setCache(docs[index])
              docs[index] = _.pick(docs[index], pickFields)
            })
          }
          else {
            docs.forEach((before, index) => {
              const after = EJSON.clone(before)
              LocalCollection._modify(after, modifier)
              const diff = DeepDiff(before, after, true)
              if (diff) {
                this.setCache(after)
                docs[index] = _.pick(after, [...diff[0], '_id'])
              }
              // nothing to change -- get rid of it
              else delete docs[index]
            })
          }

          // we run the callback after our cache is updated
          if (callback) runCallbackInBackground(() => callback.call(this, null, result))

          if (this._skipRedis || !config.pushToRedis || docs.length == 0) return result

          dispatchUpdate(
            config.optimistic,
            this._name,
            config._channels,
            docs,
            topLevelFields
          )
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

    // no point in storing, these docs will be removed => skipSave = true
    var docs = this.find(selector, { transform: null, skipSave:true, fields:{_id:1} }).fetch()
    var docIds = docs.map((doc) => doc._id)

    // nothing to remove
    if (docs.length === 0) {
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
