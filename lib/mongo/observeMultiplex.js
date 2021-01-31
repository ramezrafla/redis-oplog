// This code was started based on meteor/meteor github repository
// This code is MIT and licensed to Meteor

import { Meteor } from 'meteor/meteor'
import { LocalCollection } from 'meteor/minimongo'
import OptimisticInvocation from './optimisticInvocation'
import { _ } from 'meteor/underscore'
import { EJSON } from 'meteor/ejson'

// eslint-disable-next-line
const Future = Npm.require('fibers/future')
const CALLBACKS = ['added', 'changed', 'removed']


export function ObserveMultiplexer(options) {
  const self = this

  // eslint-disable-next-line
  Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact('mongo-livedata', 'observe-multiplexers', 1)

  this._ids = []
  this._onStop = options.onStop || function() {}
  this._collection = options.collection
  this._queue = new Meteor._SynchronousQueue()
  this._handles = {}
  this._readyFuture = new Future()
  this._cache = new LocalCollection._CachingChangeObserver({ ordered: false }) // purely for APM otherwise we get an error

  // Number of addHandleAndSendInitialAdds tasks scheduled but not yet
  // running. removeHandle uses this to know if it's time to call the onStop
  // callback.
  this._addHandleTasksScheduledButNotPerformed = 0

  if (options.fields) this.projector = LocalCollection._compileProjection(options.fields)

  CALLBACKS.forEach(function(name) {
    self[name] = function(/* ... */) { self._applyCallback(name, _.toArray(arguments)) }
  })
}

_.extend(ObserveMultiplexer.prototype, {
  addHandleAndSendInitialAdds: function(handle) {
    const self = this

    // Check this before calling runTask (even though runTask does the same
    // check) so that we don't leak an ObserveMultiplexer on error by
    // incrementing _addHandleTasksScheduledButNotPerformed and never
    // decrementing it.
    if (!this._queue.safeToRunTask()) throw new Error('Can\'t call observeChanges from an observe callback on the same query')
    ++this._addHandleTasksScheduledButNotPerformed

    // eslint-disable-next-line
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact('mongo-livedata', 'observe-handles', 1)

    this._queue.runTask(function() {
      self._handles[handle._id] = handle
      // Send out whatever adds we have so far (whether or not we the multiplexer is ready)
      self._sendAdds(handle)
      --self._addHandleTasksScheduledButNotPerformed
    })

    // *outside* the task, since otherwise we'd deadlock
    this._readyFuture.wait()
  },

  // Remove an observe handle. If it was the last observe handle, call the
  // onStop callback you cannot add any more observe handles after this.
  //
  // This is not synchronized with polls and handle additions: this means that
  // you can safely call it from within an observe callback, but it also means
  // that we have to be careful when we iterate over _handles.
  removeHandle: function(id) {
    // This should not be possible: you can only call removeHandle by having
    // access to the ObserveHandle, which isn't returned to user code until the
    // multiplex is ready.
    if (!this._ready()) throw new Error('Can\'t remove handles until the multiplex is ready')

    delete this._handles[id]

    // eslint-disable-next-line
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact('mongo-livedata', 'observe-handles', -1)

    if (_.isEmpty(this._handles) && this._addHandleTasksScheduledButNotPerformed === 0) this._stop()
  },

  _stop: function(options) {
    options = options || {}

    // It shouldn't be possible for us to stop when all our handles still
    // haven't been returned from observeChanges!
    if (!this._ready() && !options.fromQueryError) throw Error('surprising _stop: not ready')

    // Call stop callback (which kills the underlying process which sends us
    // callbacks and removes us from the connection's dictionary).
    this._onStop()

    // eslint-disable-next-line
    Package['facts-base'] && Package['facts-base'].Facts.incrementServerFact('mongo-livedata', 'observe-multiplexers', -1)

    // Cause future addHandleAndSendInitialAdds calls to throw (but the onStop
    // callback should make our connection forget about us).
    this._handles = null
    this._cache = null
    this._ids.forEach((id) => this._collection.removeSub(id))
    this._ids = []
  },

  // Allows all addHandleAndSendInitialAdds calls to return, once all preceding
  // adds have been processed. Does not block.
  ready: function() {
    const self = this
    this._queue.queueTask(function() {
      if (self._ready()) throw Error('can\'t make ObserveMultiplex ready twice!')
      self._readyFuture.return()
    })
  },

  // If trying to execute the query results in an error, call this. This is
  // intended for permanent errors, not transient network errors that could be
  // fixed. It should only be called before ready(), because if you called ready
  // that meant that you managed to run the query once. It will stop this
  // ObserveMultiplex and cause addHandleAndSendInitialAdds calls (and thus
  // observeChanges calls) to throw the error.
  queryError: function(err) {
    const self = this
    this._queue.runTask(function() {
      if (self._ready()) throw Error('can\'t claim query has an error after it worked!')
      self._stop({ fromQueryError: true })
      self._readyFuture.throw(err)
    })
  },

  // Calls 'cb' once the effects of all 'ready', 'addHandleAndSendInitialAdds'
  // and observe callbacks which came before this call have been propagated to
  // all handles. 'ready' must have already been called on this multiplexer.
  onFlush: function(cb) {
    const self = this
    this._queue.queueTask(function() {
      if (!self._ready()) throw Error('only call onFlush on a multiplexer that will be ready')
      cb()
    })
  },

  _ready: function() {
    return this._readyFuture.isResolved()
  },

  _applyCallback: function(callbackName, args) {
    const self = this

    const isOptimistic = !!OptimisticInvocation.get()
    // TODO Add a debug message here
    const runType = isOptimistic ? 'runTask' : 'queueTask'
    this._queue[runType](function() {
      // If we stopped in the meantime, do nothing.
      if (!self._handles) return

      var id = args[0]
      var doc = args[1]
      var modifiedFields = args[2]

      // First, apply the change to the cache.
      // XXX We could make applyChange callbacks promise not to hang on to any
      // state from their arguments (assuming that their supplied callbacks
      // don't) and skip this clone. Currently 'changed' hangs on to state
      // though.
      if (callbackName == 'added') {
        if (self._ids.includes(id)) console.error('ObserveMultiplex - added: Doc present!', doc)
        else {
          self._ids.push(id)
          self._collection.addSub(id)
        }
      }
      else if (callbackName == 'removed') {
        const index = self._ids.indexOf(id)
        if (index != -1) {
          self._ids.splice(index, 1)
          self._collection.removeSub(id)
        }
        else console.error('ObserveMultiplex - removed: Doc ' + id + ' not found!')
      }
      else if (callbackName == 'changed') {
        if (!self._ids.includes(id)) console.error('ObserveMultiplex - changed: Doc not present!', doc)
      }
      else {
        console.error('RedisOplog - ObserveMultiplex: Unknown callback ' + callbackName)
      }

      // If we haven't finished the initial adds, then we should only be getting adds
      if (!self._ready() && callbackName !== 'added') throw new Error('RedisOplog - ObserveMultiplex: Got ' + callbackName + ' during initial adds')

      if (self.projector && doc) {
        try { doc = self.projector(doc) }
        catch(e) { }
      }

      if (doc && modifiedFields && modifiedFields.length) doc = _.pick(doc, [...modifiedFields,'_id'])

      // Now multiplex the callbacks out to all observe handles. It's OK if
      // these calls yield since we're inside a task, no other use of our queue
      // can continue until these are done. (But we do have to be careful to not
      // use a handle that got removed, because removeHandle does not use the
      // queue thus, we iterate over an array of keys that we control.)
      _.each(self._handles, function(handle) {
        if (!handle) return
        const callback = handle['_' + callbackName]
        // clone arguments so that callbacks can mutate their arguments
        callback && callback.call(null, id, doc ? EJSON.clone(doc) : null)
      })
    })
  },

  // Sends initial adds to a handle. It should only be called from within a task
  // (the task that is processing the addHandleAndSendInitialAdds call). It
  // synchronously invokes the handle's added; there's no need to
  // flush the queue afterwards to ensure that the callbacks get out.
  _sendAdds: function(handle) {
    const self = this
    if (self._queue.safeToRunTask()) throw Error('_sendAdds may only be called from within a task!')
    const add = handle._added
    if (!add) return
    self._ids.forEach(function(id) {
      if (!_.has(self._handles, handle._id)) throw Error('handle got removed before sending initial adds!')
      // note: this is already cloned before we send out to pubs and observers
      var doc = self._collection.findOne(id)
      if (!doc) return
      if (self.projector) {
        try { doc = self.projector(doc) }
        catch(e) { }
      }
      add(id, doc)
    })
  },
})

var nextObserveHandleId = 1
export function ObserveHandle(multiplexer, callbacks) {
  const self = this
  // The end user is only supposed to call stop().  The other fields are
  // accessible to the multiplexer, though.
  self._multiplexer = multiplexer
  CALLBACKS.forEach(function(name) { if (callbacks[name]) self['_' + name] = callbacks[name] })
  self._stopped = false
  self._id = nextObserveHandleId++
}

ObserveHandle.prototype.stop = function() {
  const self = this
  if (self._stopped) return
  self._stopped = true
  self._multiplexer.removeHandle(self._id)
}
