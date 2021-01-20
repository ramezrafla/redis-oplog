// https://github.com/luin/ioredis#connect-to-redis
import Config from './config'
import extendMongoCollection from './mongo/extendMongoCollection'
import RedisSubscriptionManager from './redis/redisSubscriptionManager'
import PubSubManager from './redis/pubSubManager'
import { init as initializeRaceConditionsManager } from './redis/raceConditionsManager'
import { getRedisListener } from './redis/getRedisClient'
import deepExtend from './utils/deepExtend'
import reload from './processors/actions/reload'
import { Meteor } from 'meteor/meteor'
import { Mongo } from 'meteor/mongo'
import { check } from 'meteor/check'

let isInitialized = false

export default (config = {}) => {
  if (isInitialized) throw new Meteor.Error('RedisOplog: You cannot initialize RedisOplog twice')

  isInitialized = true

  deepExtend(Config, config)
  Config.isInitialized = true

  // this is not ready yet -- it's the beginning of the logic
  // right now optlogtoredis does not send changed values, only the field names
  // this means we need to pull from the DB in the redis subscriber
  if (Config.oplogToRedis) {
    if (Config.mutationDefaults.pushToRedis) console.error('RedisOplog: Both pushToRedis & oplogToRedis are true!')
    Config.redisPrefix = process.env.MONGO_URL.split('\/').pop().replace(/\?.*/,'') + '.'
    console.log('RedisOplog: OplogToRedis configured with db name "' + Config.redisPrefix + '"')
  }

  extendMongoCollection()

  // this initializes the listener singleton with the proper onConnect functionality
  getRedisListener({
    onConnect() {
      // this will be executed initially, but since there won't be any observable collections, nothing will happen
      // PublicationFactory.reloadAll()
      RedisSubscriptionManager.getAllRedisSubscribers().forEach((redisSubscriber) => reload(redisSubscriber.observableCollection))
    }
  })

  RedisSubscriptionManager.init()

  // used in RedisSubscriptionManager
  Config.pubSubManager = new PubSubManager()

  if ((Config.secondaryReads && Config.detectRaceConditions !== false) || Config.detectRaceConditions) initializeRaceConditionsManager()

  // wasteful events
  Meteor.startup(function() {
    const loginService = Mongo.Collection.__getCollectionByName('meteor_accounts_loginServiceConfiguration')
    loginService && loginService.disableRedis()
  })
}

// duplicate this code in your app with appropriate user management to get the info in production
if (Meteor.isDevelopment) {
  Meteor.methods({
    __getCollectionStats: function(collectionName) {
      check(collectionName, String)
      const collection = Mongo.Collection.__getCollectionByName(collectionName)
      if (!collection) throw new Meteor.Error('Not a valid collection')
      return {
        hits: collection._hits,
        misses: collection._misses,
        hitRatio: collection._hits ? 100 * collection._hits / (collection._hits + collection._misses) : 0
      }
    }
  })
}

