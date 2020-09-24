import { Events } from '../../constants'

/**
 * @param observableCollection
 * @param newCommer
 * @param event
 * @param modifiedFields
 */
export default function (observableCollection, newCommer, event, modifiedFields) {
  const { selector, options } = observableCollection

  const newStore = new Map()
  const freshIds = observableCollection.collection.find(selector, { ...options, fields: { _id: 1, updatedAt: 1 } }).fetch()
  freshIds.forEach((doc) => newStore.set(doc._id, doc))

  let added = false
  observableCollection.compareWith(newStore, {
    leftOnly(docId) {
      observableCollection.remove(docId)
    },
    rightOnly(doc) {
      if (newCommer && doc._id == newCommer._id) {
        added = true
        observableCollection.add(newCommer)
      }
      else {
        observableCollection.addById(doc._id)
      }
    }
  })

  // if we have an update, and we have a newcommer, that new commer may be inside the ids
  // TODO: maybe refactor this in a separate action (?)
  if (newCommer
        && Events.UPDATE === event
        && modifiedFields
        && !added
        && observableCollection.has(newCommer._id)) {
    observableCollection.change(newCommer, modifiedFields)
  }
}
