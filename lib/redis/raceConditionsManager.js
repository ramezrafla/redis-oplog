import { getTime } from '../mongo/extendMongoCollection'
import { _ } from 'meteor/underscore'
import { Mongo, MongoInternals } from 'meteor/mongo'
import { dispatchEvents} from './customPublish'
import { Meteor } from 'meteor/meteor'
import debug from '../debug'
import Config from '../config'
import { Events, RedisPipe } from '../constants'
import getDedicatedChannel from '../utils/getDedicatedChannel'
import getChannelName from '../utils/getChannelName'

var skip = true
var driver
var fieldsToSkip = { }
const masterCollections = { }
const history = { }
var TIMEOUT = 300

export const onMutation = (collectionName, _id, fields) => {
  if (skip) return
  const uid = collectionName + '-' + _id
  const item = history[uid]
  const now = getTime()
  if (item) {
    if (item.timer) {
      debug('[RaceConditionsManager - onMutation] Skipping ' + uid + ' as we are waiting for forced update')
    }
    // it's too far out - we are ok
    else if (now - item.updatedAt > TIMEOUT) history[uid] = {
      uid,
      collectionName,
      _id,
      fields,
      updatedAt: now
    }
    // check for fields collision
    else if (fields && item.fields && _.without(_.intersection(item.fields, fields), ...fieldsToSkip[collectionName]).length == 0) {
      // no fields have collided, we are ok -- the drawback here is that we are resetting the timer for the prior fields
      // handling timestamp by group of fields would complicate this part quite a bit
      item.fields = _.union(fields, item.fields)
      item.updatedAt = now
    }
    // either we have field collision or the doc was removed
    else {
      console.log('Redis-Oplog: Race condition on ' + uid + (fields ? ' ' + fields.join(', ') : ''))
      // we use random in the timer as a crude form of collision detection between the different Meteor servers
      item.timer = Meteor.setTimeout(() => onTimer(uid), 100 + Math.random()*100)
      item.updatedAt = now
    }
  }
  else history[uid] = {uid, collectionName, _id, fields, updatedAt:now}
}

export const onForceUpdate = (collectionName, _id) => {
  if (skip) return
  const uid = collectionName + '-' + _id
  debug('[RaceConditionsManager - onForceUpdate] ' + uid)
  const item = history[uid]
  if (item) {
    if (item.timer) Meteor.clearTimeout(item.timer)
    delete history[uid]
  }
}

export const onTimer = (uid) => {
  if (skip) return
  debug('[RaceConditionsManager - onTimer] ' + uid)
  const item = history[uid]
  delete history[uid]
  var collection = masterCollections[item.collectionName]
  if (!collection) collection = masterCollections[item.collectionName] = new Mongo.Collection(item.collectionName, { _driver:driver, defineMutationMethods:false });
  const _id = item._id
  const doc = collection.findOne(_id)
  if (doc) dispatchForceUpdate(item.collectionName, doc)
  else dispatchForceRemove(item.collectionName, _id)
}

export const init = () => {
  console.log('RedisOplog: RaceConditionsManager started')
  // Mongo URL without readPreference so we can read from primary
  const mongoURL = process.env.MONGO_URL.replace(/readPreference=[^&]+\&?/,'')
  // Mongo driver so we can read from primary node
  driver = new MongoInternals.RemoteCollectionDriver(mongoURL)
  fieldsToSkip = Config.raceDetectionFieldsToSkip || { }
  TIMEOUT = Config.raceDetectionDelay || 300
  skip = false
  setTimeout(cleanupHistory, 10 * TIMEOUT)
}

const cleanupHistory = () => {
  const cutoff = getTime() - TIMEOUT
  _.each(history, ({updatedAt}, uid) => {
    if (updatedAt < cutoff) delete history[uid]
  })
}

export const dispatchForceUpdate = function(collectionName, doc) {
  const channels = [
    getDedicatedChannel(collectionName, doc._id),
    getChannelName(collectionName)
  ]
  const events = [{
    [RedisPipe.EVENT]: Events.FORCEUPDATE,
    [RedisPipe.DOC]: doc
  }]
  dispatchEvents(channels, events)
}

export const dispatchForceRemove = function(collectionName, _id) {
  const channels = [
    getDedicatedChannel(collectionName, _id),
    getChannelName(collectionName)
  ]
  const events = [{
    [RedisPipe.EVENT]: Events.FORCEREMOVE,
    [RedisPipe.DOC]: {_id},
  }]
  dispatchEvents(channels, events)
}

