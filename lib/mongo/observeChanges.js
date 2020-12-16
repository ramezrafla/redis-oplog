// This code was started based on meteor/meteor github repository
// This code is MIT and licensed to Meteor.

import RedisOplogObserveDriver from './redisOplogObserveDriver'
import { ObserveMultiplexer, ObserveHandle } from './observeMultiplex'
import PollingObserveDriver from './pollingObserveDriver'
import { _ } from 'meteor/underscore'
import { EJSON } from 'meteor/ejson'
import { Meteor } from 'meteor/meteor'
import { Minimongo } from 'meteor/minimongo'
import { Mongo } from 'meteor/mongo'

export default function(cursorDescription, ordered, callbacks) {
  const self = this

  if (cursorDescription.options.tailable) return self._observeChangesTailable(cursorDescription, ordered, callbacks)

  // You may not filter out _id when observing changes, because the id is a core
  // part of the observeChanges API.
  if (cursorDescription.options.fields && (cursorDescription.options.fields._id === 0 || cursorDescription.options.fields._id === false)) {
    throw Error('You may not observe a cursor with {fields: {_id: 0}}')
  }

  var observeKey = EJSON.stringify(cursorDescription)
  var multiplexer
  var observeDriver
  var firstHandle = false // Find a matching ObserveMultiplexer, or create a new one. This next block is
  // guaranteed to not yield (and it doesn't call anything that can observe a
  // new query), so no other calls to this function can interleave with it.
  var collectionName = cursorDescription.collectionName
  var collection = Mongo.Collection.__getCollectionByName(collectionName)

  Meteor._noYieldsAllowed(function() {
    if (_.has(self._observeMultiplexers, observeKey)) {
      multiplexer = self._observeMultiplexers[observeKey]
    }
    else {
      firstHandle = true // Create a new ObserveMultiplexer, observeDriver (which creates an ObservableCollection)
      multiplexer = new ObserveMultiplexer({
        collection,
        fields: cursorDescription.options.fields, // needed to project fields from cache
        onStop: function() { // triggered by multiplexer when the last observeHandle is stopped
          delete self._observeMultiplexers[observeKey]
          observeDriver.stop()
        }
      })
      self._observeMultiplexers[observeKey] = multiplexer
    }
  })

  const observeHandle = new ObserveHandle(multiplexer, callbacks)

  if (firstHandle) {
    var matcher, sorter
    var canUseOplog = _.all(
      [
        function() {
          // At a bare minimum, using the oplog requires us to have an oplog, to
          // want unordered callbacks, and to not want a callback on the polls
          // and we skip the interal collection for login services
          // that won't happen.
          return !ordered && !callbacks._testOnlyPollCallback && cursorDescription.collectionName != "meteor_accounts_loginServiceConfiguration"
        },
        function() {
          // We need to be able to compile the selector. Fall back to polling for
          // some newfangled $selector that minimongo doesn't support yet.
          try {
            matcher = new Minimongo.Matcher(cursorDescription.selector)
            return true
          }
          catch (e) {
            // XXX make all compilation errors MinimongoError or something
            //     so that this doesn't ignore unrelated exceptions
            return false
          }
        },
        function() {
          // ... and the selector itself needs to support oplog.
          return RedisOplogObserveDriver.cursorSupported(cursorDescription, matcher)
        },
        function() {
          // And we need to be able to compile the sort, if any.  eg, can't be
          // {$natural: 1}.
          if (!cursorDescription.options.sort) return true
          try {
            sorter = new Minimongo.Sorter(cursorDescription.options.sort, { matcher })
            return true
          }
          catch (e) {
            // XXX make all compilation errors MinimongoError or something
            //     so that this doesn't ignore unrelated exceptions
            return false
          }
        },
      ],
      function(f) {
        return f()
      }
    ) // invoke each function

    var DriverClass = canUseOplog ? RedisOplogObserveDriver : PollingObserveDriver

    observeDriver = new DriverClass({
      cursorDescription,
      collection,
      mongoHandle: self,
      multiplexer,
      ordered,
      matcher,
      // ignored by polling
      sorter,
      // ignored by polling
      _testOnlyPollCallback: callbacks._testOnlyPollCallback,
    }) // This field is only set for use in tests.

    multiplexer._observeDriver = observeDriver
  }

  // ObservableCollection created in by RedisOplogObserverDrivier has already initialized
  // by now and added the needed docs for initial add
  // This call also blocks until the initial adds have been sent by ObservableCollection
  multiplexer.addHandleAndSendInitialAdds(observeHandle)

  return observeHandle
}
