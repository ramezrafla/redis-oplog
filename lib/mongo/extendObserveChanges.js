import { MongoInternals } from 'meteor/mongo'
import observeChanges from './observeChanges'

Object.getPrototypeOf(MongoInternals.defaultRemoteCollectionDriver().mongo.find()).constructor

export default function() {
  MongoInternals.Connection.prototype._observeChanges = observeChanges
}
