import { Strategy } from '../constants'
import { getProcessor } from '../processors'
import { Meteor } from 'meteor/meteor'
import extractIdsFromSelector from '../utils/extractIdsFromSelector'
import RedisSubscriptionManager from './RedisSubscriptionManager'
import getDedicatedChannel from '../utils/getDedicatedChannel'

export default class RedisSubscriber {
  /**
     * @param observableCollection
     * @param strategy
     */
  constructor(observableCollection, strategy) {
    this.observableCollection = observableCollection
    this.strategy = strategy

    // the heart of this subscriber
    this.processor = getProcessor(strategy)
    this.channels = this.getChannels()

    RedisSubscriptionManager.attach(this)
  }

  /**
     * @param channels
     * @returns {*}
     */
  getChannels() {
    switch (this.strategy) {
      case Strategy.DEFAULT:
      case Strategy.LIMIT_SORT:
        return this.observableCollection.channels
      case Strategy.DEDICATED_CHANNELS:
        var collectionName = this.observableCollection.collectionName
        var ids = extractIdsFromSelector(this.observableCollection.selector)
        return ids.map((id) => getDedicatedChannel(collectionName, id))
      default:
        throw new Meteor.Error(`Strategy could not be found: ${this.strategy}`)
    }
  }

  /**
     * @param args
     */
  process(...args) {
    this.processor.call(null, this.observableCollection, ...args)
  }

  /**
     * Detaches from RedisSubscriptionManager
     */
  stop() {
    try { RedisSubscriptionManager.detach(this) }
    catch (e) { console.warn(`[RedisSubscriber] Weird! There was an error while stopping the publication: `, e) }
  }

}
