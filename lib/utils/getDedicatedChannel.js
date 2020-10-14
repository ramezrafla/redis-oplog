import { MongoID } from 'meteor/mongo-id'
import Config from '../config'

export default function getDedicatedChannel(collectionName, docId) {
  return (Config.redisPrefix || '') + `${collectionName}::${MongoID.idStringify(docId)}`
}
