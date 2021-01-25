import { _ } from 'meteor/underscore'

export function isIdSelector(selector) {
  if (typeof selector == 'string') return true
  return selector && selector._id && _.keys(selector).length == 1
}

export function getIdsSelector(selector) {
  return typeof selector._id === 'string' ? [selector._id] : _.isObject(selector._id) && selector._id.$in ? selector._id.$in : null
}
