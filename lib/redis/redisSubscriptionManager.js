import { Meteor } from 'meteor/meteor'
import { Random } from 'meteor/random'
import { _ } from 'meteor/underscore'
import debug from '../debug'
import { RedisPipe, Events } from '../constants'
import Config from '../config'
import { Mongo } from 'meteor/mongo'
import { LocalCollection } from 'meteor/minimongo'
import { onForce, onMutation } from './raceDetectionManager'

class RedisSubscriptionManager {
  init() {
    if (this.isInitialized) return
    this.uid = Random.id()
    this.queue = new Meteor._SynchronousQueue()
    this.subscribers = {} // {channel: [RedisSubscribers]}
    this.watchers = {}
    this.channelHandlers = {} // {channel: handler}
    this.isInitialized = true
  }

  /**
     * Returns all RedisSubscribers regardless of channel
     */
  getAllRedisSubscribers() {
    const redisSubscribers = []
    // eslint-disable-next-line
    for (var channel in this.subscribers) {
      this.subscribers[channel].forEach((_redisSubscriber) => redisSubscribers.push(_redisSubscriber))
    }
    return redisSubscribers
  }

  /**
     * @param redisSubscriber
     */
  attach(redisSubscriber) {
    this.queue.queueTask(() => {
      _.each(redisSubscriber.channels, (channel) => {
        if (!this.subscribers[channel]) this.initializeChannel(channel)
        this.subscribers[channel].push(redisSubscriber)
      })
    })
  }

  /**
     * @param redisSubscriber
     */
  detach(redisSubscriber) {
    this.queue.queueTask(() => {
      _.each(redisSubscriber.channels, (channel) => {
        if (!this.subscribers[channel]) return debug('[RedisSubscriptionManager] Trying to detach a subscriber on a non existent channels.')
        this.subscribers[channel] = _.without(this.subscribers[channel], redisSubscriber)
        if (this.subscribers[channel].length === 0 && !this.watchers[channel]) this.destroyChannel(channel)
      })
    })
  }

  startWatch(channel) {
    if (!this.channelHandlers[channel]) this.initializeChannel(channel)
  }

  stopWatch(channel) {
    if (!this.subscribers[channel] || this.subscribers[channel].length == 0) this.destroyChannel(channel)
  }

  /**
     * @param channel
     */
  initializeChannel(channel) {
    debug(`[RedisSubscriptionManager] Subscribing to channel: ${channel}`)

    // create the handler for this channel
    const self = this
    const handler = function(message) {
      self.queue.queueTask(() => self.process(channel, message, true))
    }

    this.channelHandlers[channel] = handler
    this.subscribers[channel] = []

    const { pubSubManager } = Config
    pubSubManager.subscribe(channel, handler)
  }

  /**
     * @param channel
     */
  destroyChannel(channel) {
    debug(`[RedisSubscriptionManager] Unsubscribing from channel: ${channel}`)

    const { pubSubManager } = Config
    pubSubManager.unsubscribe(channel, this.channelHandlers[channel])

    delete this.subscribers[channel]
    delete this.channelHandlers[channel]
    delete this.watchers[channel]
  }

  /**
     * @param channel
     * @param data
     * @param [fromRedis=false]
     */
  process(channel, data, fromRedis) {
    // messages from redis that contain our uid were handled optimistically, so we can drop them
    if (fromRedis && data[RedisPipe.UID] === this.uid) return

    const subscribers = this.subscribers[channel]
    const hasSubs = subscribers?.length
    if (!hasSubs && !this.watchers[channel]) return

    debug(`[RedisSubscriptionManager] Received event: "${data[RedisPipe.EVENT]}" to "${channel}"`)

    const collectionName = channel.split('::').shift()
    const collection = hasSubs ? subscribers[0].observableCollection.collection : Mongo.Collection.__getCollectionByName(collectionName)

    var doc = data[RedisPipe.DOC]
    var event = data[RedisPipe.EVENT]
    const fields = data[RedisPipe.FIELDS]

    // for insert and remove we can take the passed on doc
    if (event == Events.FORCEUPDATE) {
      event = Events.UPDATE
      onForce(collectionName, doc._id)
      // acts as an insert
      collection.setCache(doc)
    }
    else if (event == Events.FORCEREMOVE) {
      event = Events.REMOVE
      onForce(collectionName, doc._id)
      collection.deleteCache(doc._id)
    }
    else if (event === Events.UPDATE) {
      const collectionDoc = collection.findOne(doc._id)
      // doc is gone in the mean time!!
      if (!collectionDoc) return
      const setter = _.omit(doc,'_id')
      const cleared = data[RedisPipe.CLEARED]
      if (cleared?.length) _.each(cleared, (k) => setter[k] = undefined)
      onMutation(collectionName, doc._id, fields, setter)
      LocalCollection._modify(collectionDoc, {$set:setter})
      doc = collectionDoc
      collection.setCache(doc)
    }
    else if (event === Events.INSERT) {
      onMutation(collectionName, doc._id, fields, _.omit(doc,'_id'))
      collection.setCache(doc)
    }
    else if (event === Events.REMOVE) {
      onMutation(collectionName, doc._id)
      collection.deleteCache(doc._id)
    }

    if (hasSubs) {
      if (fromRedis) {
        subscribers.forEach((redisSubscriber) => {
          Meteor.defer(() => {
            try { redisSubscriber.process(event, doc, fields) }
            catch (e) { debug(`[RedisSubscriptionManager] Exception while processing event: ${e.toString()}`) }
          })
        })
      }
      else {
        // if it's our client that made the change we dispatch it right away
        subscribers.forEach((redisSubscriber) => {
          try { redisSubscriber.process(event, doc, fields) }
          catch (e) { debug(`[RedisSubscriptionManager] Exception while processing event: ${e.toString()}`) }
        })
      }
    }
  }
}

export default new RedisSubscriptionManager()
