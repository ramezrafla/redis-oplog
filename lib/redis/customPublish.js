import getDedicatedChannel from '../utils/getDedicatedChannel'
import RedisSubscriptionManager from './redisSubscriptionManager'
import { getRedisPusher } from './getRedisClient'
import { EJSON } from 'meteor/ejson'
import { Events, RedisPipe } from '../constants'
import { _ } from 'meteor/underscore'

export const dispatchUpdate = function(collectionName, id, doc, cleared) {
  const channel = getDedicatedChannel(collectionName, id)
  const events = [{
    [RedisPipe.EVENT]: Events.UPDATE,
    [RedisPipe.FIELDS]: _.without(_.keys(doc),'_id'),
    [RedisPipe.CLEARED]: cleared,
    [RedisPipe.DOC]: doc,
    [RedisPipe.UID]: RedisSubscriptionManager.uid,
  }]
  dispatchEvents(channel, events)
}

export const dispatchInsert = function(collectionName, id, doc) {
  const channel = getDedicatedChannel(collectionName, id)
  const events = [{
    [RedisPipe.EVENT]: Events.INSERT,
    [RedisPipe.DOC]: doc,
    [RedisPipe.UID]: RedisSubscriptionManager.uid,
  }]
  dispatchEvents(channel, events)
}


export const dispatchRemove = function(collectionName, id, ids) {
  const channel = getDedicatedChannel(collectionName, id)
  const uid = RedisSubscriptionManager.uid
  if (!Array.isArray(ids)) ids = [ids]
  const events = ids.map((_id) => ({
    [RedisPipe.EVENT]: Events.REMOVE,
    [RedisPipe.DOC]: {_id},
    [RedisPipe.UID]: uid,
  }))
  dispatchEvents(channel, events)
}


export const dispatchEvents = function(channel, events) {
  const client = getRedisPusher()
  events.forEach((event) => {
    const json = EJSON.stringify(event)
    if (typeof channel == 'string') client.publish(channel, json)
    else channel.forEach((channel) => client.publish(channel, json))
  })
}
