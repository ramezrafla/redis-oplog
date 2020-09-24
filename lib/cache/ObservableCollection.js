import { _ } from 'meteor/underscore'
import getChannels from './lib/getChannels'

const allowedOptions = [
  'limit',
  'skip',
  'sort',
  'fields',
  'channels',
  'channel',
  'namespace',
  'namespaces',
]


export default class ObservableCollection {
  /**
     * Instantiate the collection
     * @param {*} param
     */
  constructor({ multiplexer, matcher, collection, cursorDescription }) {
    this.multiplexer = multiplexer
    this.matcher = matcher
    this.cursorDescription = cursorDescription
    this.collection = collection
    // needed by RedisSubscriber to get channels with IDs
    this.collectionName = collection._name

    this.ids = new Map()

    // selector - used by RedisSubscriber
    this.selector = this.cursorDescription.selector || {}
    if (typeof this.selector == 'string') this.selector = { _id: this.selector }

    // options
    if (this.cursorDescription.options) {
      this.options = _.pick(this.cursorDescription.options, ...allowedOptions)
    }
    else {
      this.options = {}
    }

    // channels - used by RedisSubscriber
    this.channels = getChannels(this.collection._name, this.options)

    this.__isInitialized = false
  }

  /**
     * Function that checks whether or not the doc matches our filters
     *
     * @param doc
     * @returns {*}
     */
  isEligible(doc) {
    if (this.matcher) return this.matcher.documentMatches(doc).result
    return true
  }

  /**
     * @param _id
     * @returns {boolean}
     */
  isEligibleByDB(_id) {
    if (this.matcher) return !!this.collection.findOne(_.extend({}, this.selector, { _id }), { fields: { _id: 1 } })
    return true
  }

  /**
     * Performs the initial search then puts them into the store.
     */
  init() {
    if (this.__isInitialized) return // silently do nothing.

    this.__isInitialized = true


    // we need to fill the multiplexer with the first adds
    var docIds, docs
    const selector = this.selector
    if (selector && selector._id && _.keys(selector).length == 1) {
      docIds = typeof selector._id === 'string' ? [selector._id] : _.isObject(selector._id) && selector._id.$in ? selector._id.$in : null
    }
    const findOptions = { ...this.options, fields:{}}
    if (docIds) {
      // we set skipClone to true as we want to maintain refs to the docs in the multiplexer cache
      docs = this.collection.fetchInCacheFirst(docIds, findOptions)
    }
    else {
      docs = this.collection.find(selector, findOptions).fetch()
      // we set skipClone to true as we want to maintain refs to the docs in the multiplexer cache
      this.collection.mergeDocs(docs, true)
    }
    docs.forEach((doc) => this.add(doc, true))

    this.multiplexer.ready()
  }

  /**
     * @param docId
     * @returns {boolean}
     */
  contains(docId) {
    return this.ids.has(docId)
  }

  /**
     * @param doc {Object}
     * @param safe {Boolean} If this is set to true, it assumes that the object is cleaned
     */
  add(doc) {
    this.ids.set(doc._id, doc.updatedAt || new Date())
    this.multiplexer.added(doc._id, doc)
  }

  /**
     * We use this method when we receive updates for a document that is not yet in the observable collection store
     * @param docId
     */
  addById(docId) {
    const doc = this.collection.findOne(docId)
    this.ids.set(doc._id, doc.updatedAt || new Date())
    if (doc) this.multiplexer.added(docId, doc)
  }

  /**
     * Sends over the wire only the top fields of changes, because DDP client doesnt do deep merge.
     *
     * @param {object} doc
     * @param {array} modifiedFields
     */
  change(doc, modifiedFields) {
    this.ids.set(doc._id, doc.updatedAt || new Date())
    return this.multiplexer.changed(doc._id, doc, modifiedFields)
  }


  /**
   * Sends over the wire only the top fields of changes, because DDP client doesnt do deep merge.
   *
   * @param {object} doc
   * @param {array} modifiedFields
   */
  changeById(docId, modifiedFields) {
    const doc = this.collection.findOne(docId, null)
    this.ids.set(doc._id, doc.updatedAt || new Date())
    if (doc) this.multiplexer.changed(docId, doc, modifiedFields)
  }

  /**
     * @param docId
     */
  remove(docId) {
    if (this.ids.has(docId)) {
      this.ids.delete(docId)
      this.multiplexer.removed(docId)
    }
  }

  /**
     * Clears the store
     */
  clearStore() {
    this.ids.clear()
  }

  /**
     * Returns whether the limit of allowed documents is reached
     * based on the selector options
     */
  isLimitReached() {
    if (this.options.limit) {
      const size = this.ids.size()
      return size >= this.options.limit
    }
    return false
  }

  compareWith(rightMap, callbacks) {
    // operate on the _internal maps to avoid overhead of parsing id's.
    const leftMap = this.ids

    leftMap.forEach((leftUpdatedAt, key) => {
      const rightValue = rightMap.get(key)
      if (rightValue != null) {
        if (callbacks.both) {
          if (!rightValue.updatedAt || leftUpdatedAt - rightValue.updatedAt < 0) callbacks.both(rightValue)
        }
      }
      else
        callbacks.leftOnly && callbacks.leftOnly(this._idParse(key))
    })
    if (callbacks.rightOnly) {
      rightMap.forEach((rightValue, key) => {
        if (!leftMap.has(key)) callbacks.rightOnly(rightValue)
      })
    }
  }


}
