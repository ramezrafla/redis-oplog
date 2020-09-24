import RedisSubscriptionManager from './RedisSubscriptionManager'
import getDedicatedChannel from '../utils/getDedicatedChannel'

export const addToWatch = function(collectionName, id) {
  const channel = getDedicatedChannel(collectionName, id)
  RedisSubscriptionManager.startWatch(channel)
  if (RedisSubscriptionManager.watchers[channel] == null) RedisSubscriptionManager.watchers[channel] = 0
  ++RedisSubscriptionManager.watchers[channel]
}

export const removeFromWatch = function(collectionName, id) {
  const channel = getDedicatedChannel(collectionName, id)
  if (!RedisSubscriptionManager.watchers[channel]) return
  --RedisSubscriptionManager.watchers[channel]
  if (RedisSubscriptionManager.watchers[channel] == 0) {
    delete RedisSubscriptionManager.watchers[channel]
    RedisSubscriptionManager.stopWatch(channel)
  }
}
