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
const fieldsToIgnore = { }
const masterCollections = { }
const history = { }
var TIMEOUT = 300

export const onMutation = (collectionName, _id, fields, doc) => {
  if (skip) return
  const uid = collectionName + '-' + _id
  const item = history[uid]
  const now = getTime()
  if (doc && fieldsToIgnore[collectionName]) {
    fields = _.without(fields, ...fieldsToIgnore[collectionName])
    if (fields.length == 0) return
    doc = _.pick(doc, fields)
  }
  if (item) {
    if (item.timer) {
      debug('[RaceDetectionManager - onMutation] Skipping ' + uid + ' as we are waiting for forced update')
    }
    // it's too far out - we are ok
    else if (now - item.updatedAt > TIMEOUT) history[uid] = {
      collectionName,
      _id,
      fields,
      doc,
      updatedAt: now
    }
    // check for fields collision
    else if (fields && item.fields) {
      const common = _.intersection(item.fields, fields)
      if (common.length && compareObject(item.doc, doc, common)) {
        console.log('Redis-Oplog: Potential race condition on ' + uid + ' ' + common.join(', '))
        // we use random in the timer as a crude form of collision detection between the different Meteor servers
        // inspired by CDMA .. see onForce below which cancels the call to primary DB node
        item.timer = Meteor.setTimeout(() => onTimer(uid), 100 + Math.random()*500)
      }
      // if there is no collision the drawback here is that we are resetting the timer for the prior fields as well
      // handling timestamp by group of fields would complicate this part quite a bit and increase CPU consumption for each query
      // however, from a DB perspective, this bundling can be seen as rational as the DB may flag this document as in-flux and fields
      // may not have properly propagate to secondaries yet
      item.updatedAt = now
      item.fields = _.union(item.fields, fields)
      item.doc = _.extend(item.doc, doc)
    }
    // either we have field collision or the doc was removed
    else {
      console.log('Redis-Oplog: Potential race condition on ' + uid + (fields ? ' ' + fields.join(', ') : ''))
      // we use random in the timer as a crude form of collision detection between the different Meteor servers
      // inspired by CDMA .. see onForce below which cancels the call to primary DB node
      item.timer = Meteor.setTimeout(() => onTimer(uid), 100 + Math.random()*500)
    }
  }
  else history[uid] = { collectionName, _id, fields, doc, updatedAt:now }
}

function compareObject(doc1, doc2, fields) {
  var l = fields.length
  for (var i = 0; i < l; i++) {
    const field = fields[i]
    if (compare(doc1[field], doc2[field])) return true
  }
}

function compare(a,b) {
  if (a === b) return false
  const typeA = typeof a
  // eslint-disable-next-line
  if (typeA !== typeof b) return true
  if (['number','string','boolean'].includes(typeA)) return true
  var isEmptyA = _.isEmpty(a)
  var isEmptyB = _.isEmpty(b)
  if (isEmptyA !== isEmptyB) return true
  return false
}


export const onForce = (collectionName, _id) => {
  if (skip) return
  const uid = collectionName + '-' + _id
  debug('[RaceDetectionManager - onForce] ' + uid)
  const item = history[uid]
  if (item) {
    // we cna stop our own timer since another Meteor instance took care of it
    if (item.timer) Meteor.clearTimeout(item.timer)
    delete history[uid]
  }
}

export const onTimer = (uid) => {
  debug('[RaceDetectionManager - onTimer] ' + uid)
  const item = history[uid]
  // maybe an onForce was called in the mean time
  if (item) {
    delete history[uid]
    var collection = masterCollections[item.collectionName]
    if (!collection) {
      if (driver) collection = new Mongo.Collection(item.collectionName, { _driver:driver, defineMutationMethods:false })
      else collection = Mongo.Collection.__getCollectionByName(item.collectionName)
      masterCollections[item.collectionName] = collection
    }
    const _id = item._id
    // we only delete from cache if we are sure we getting it from the 'regular' collection not our own direct link to master
    if (!driver) collection.deleteCache(_id)
    const doc = collection.findOne(_id)
    if (doc) dispatchForceUpdate(item.collectionName, doc)
    else dispatchForceRemove(item.collectionName, _id)
  }
}

export const init = () => {
  console.log('RedisOplog: RaceDetectionManager started')
  // Mongo URL without readPreference so we can read from primary
  if (Config.secondaryReads) {
    const mongoURL = process.env.MONGO_URL.replace(/readPreference=[^&]+\&?/,'')
    // Mongo driver so we can read from primary node
    driver = new MongoInternals.RemoteCollectionDriver(mongoURL)
  }
  TIMEOUT = Config.raceDetectionDelay || 300
  skip = false
  setInterval(cleanupHistory, 10 * TIMEOUT)
}

export const setFieldsToIgnore = (collectionName, fields) => {
  debug('[RaceDetectionManager - setFieldsToIgnore]: ' + collectionName + ' ' + fields.join(', '))
  fieldsToIgnore[collectionName] = _.clone(fields)
}

const cleanupHistory = () => {
  // console.log(history)
  const cutoff = getTime() - TIMEOUT
  _.each(history, ({updatedAt, timer}, uid) => {
    if (updatedAt < cutoff && !timer) delete history[uid]
  })
}

// note: instance UID is not provided as we are sending to redis for all instances, including our own
// no optimistic handling as this event is triggered server-side programmatically

export const dispatchForceUpdate = function(collectionName, doc) {
  const channels = [
    getDedicatedChannel(collectionName, doc._id),
    getChannelName(collectionName)
  ]
  const events = [{
    [RedisPipe.EVENT]: Events.FORCEUPDATE,
    [RedisPipe.FIELDS]: _.without(_.keys(doc), '_id'),
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

