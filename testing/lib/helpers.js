import {waitForHandleToBeReady, callWithPromise} from './sync_utils';
import { Meteor } from 'meteor/meteor'

export default (suffix) => {
  const create = (...args) => {
    Meteor.call(`create.${suffix}`, ...args);
  };

  const createSync = (...args) => callWithPromise(`create.${suffix}`, ...args);

  const fetch = (...args) => {
    Meteor.call(`fetch.${suffix}`, ...args);
  };

  const fetchSync = (...args) => callWithPromise(`fetch.${suffix}`, ...args);

  const remove = (...args) => {
    Meteor.call(`remove.${suffix}`, ...args);
  };

  const removeSync = (...args) => callWithPromise(`remove.${suffix}`, ...args);

  const update = (...args) => {
    Meteor.call(`update.${suffix}`, ...args);
  };

  const updateSync = (...args) => callWithPromise(`update.${suffix}`, ...args);

  const upsert = (...args) => {
    Meteor.call(`upsert.${suffix}`, ...args);
  };

  const upsertSync = (...args) => callWithPromise(`upsert.${suffix}`, ...args);

  const subscribe = (...args) => Meteor.subscribe(`publication.${suffix}`, ...args);

  return {
    create,
    createSync,
    update,
    updateSync,
    upsert,
    upsertSync,
    fetch,
    fetchSync,
    remove,
    removeSync,
    subscribe,
    waitForHandleToBeReady
  }
}
