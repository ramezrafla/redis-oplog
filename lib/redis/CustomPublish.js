import getDedicatedChannel from '../utils/getDedicatedChannel'
import { Meteor } from 'meteor/meteor'
import RedisSubscriptionManager from './RedisSubscriptionManager'
import { getRedisPusher } from './getRedisClient'
import { EJSON } from 'meteor/ejson'
import { Events, RedisPipe } from '../constants'


export const dispatchUpdate = function(collectionName, id, doc) {
  const channel = getDedicatedChannel(collectionName, id)
  const events = [{
    [RedisPipe.EVENT]: Events.UPDATE,
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
  const events = ids.map((_id) => ({
    [RedisPipe.EVENT]: Events.REMOVE,
    [RedisPipe.DOC]: {_id},
    [RedisPipe.UID]: uid,
  }))
  dispatchEvents(channel, events)
}


const dispatchEvents = function(channel, events) {
  Meteor.defer(() => {
    const client = getRedisPusher()
    events.forEach((event) => client.publish(channel, EJSON.stringify(event)))
  })
}
