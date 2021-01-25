import { _ } from 'meteor/underscore'
import getChannels from './lib/getChannels'
import { isIdSelector, getIdsFromSelector } from '../mongo/lib/idSelector'

// fields is omitted from here as the multiplexer is the one that handles field projection
const allowedOptions = [
  'limit',
  'skip',
  'sort',
  'default',
  'channels',
  'channel'
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
    else this.options = { }

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
     * Performs the initial search then puts them into the store.
     */
  init() {
    if (this.__isInitialized) return // silently do nothing.

    this.__isInitialized = true


    // we need to fill the multiplexer with the first adds
    var docIds, docs
    const selector = this.selector
    if (isIdSelector(selector)) {
      docIds = getIdsFromSelector(selector)
    }
    if (docIds) {
      docs = this.collection.fetchInCacheFirst(docIds, this.options)
    }
    else {
      docs = this.collection.find(selector, this.options).fetch()
      this.collection.mergeDocs(docs)
    }
    docs.forEach((doc) => this.add(doc))

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
    if (doc) {
      this.ids.set(doc._id, doc.updatedAt || new Date())
      this.multiplexer.added(docId, doc)
    }
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
        callbacks.leftOnly && callbacks.leftOnly(key)
    })
    if (callbacks.rightOnly) {
      rightMap.forEach((rightValue, key) => {
        if (!leftMap.has(key)) callbacks.rightOnly(rightValue)
      })
    }
  }


}
