import { _ } from 'meteor/underscore'

export function isIdSelector(selector) {
  if (typeof selector == 'string') return true
  return selector && selector._id && _.keys(selector).length == 1
}

export function getIdsFromSelector(selector) {
  if (typeof selector == 'string') {
    return [selector]
  } else if (typeof selector._id === 'string' || typeof selector._id._str === 'string') {
    return [selector._id];
  } else {
    return _.isObject(selector._id) && selector._id.$in ? selector._id.$in : null;
  }
}