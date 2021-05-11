/**
 * Most likely used when redis connection resumes.
 * It refreshes the collection from the database.
 *
 * @param observableCollection
 */
export default function (observableCollection) {
  const { selector, options } = observableCollection

  const newStore = new Map()

  // IMPORTANT: We may face race conditions if we are reading from secondaries
  const freshIds = observableCollection.collection.find(selector, { ...options, fields: { _id: 1, updatedAt: 1 } }).fetch()
  freshIds.forEach((doc) => newStore.set(doc._id, doc))

  observableCollection.compareWith(newStore, {
    both(newDoc) {
      observableCollection.changeById(newDoc._id)
    },
    leftOnly(docId) {
      observableCollection.remove(docId)
    },
    rightOnly(newDoc) {
      observableCollection.addById(newDoc._id)
    }
  })
}
