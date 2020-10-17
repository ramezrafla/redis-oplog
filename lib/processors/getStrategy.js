import { Strategy } from '../constants'

/**
 * @param selector
 * @param options
 * @returns {*}
 */
export default function getStrategy(selector = {}, options = {}) {
  if (options.default) return Strategy.DEFAULT

  if (options.limit) {
    // you NEED a sort for limits
    if (!options.sort) options.sort = { _id: 1 }
    return Strategy.LIMIT_SORT
  }

  if (selector && selector._id) return Strategy.DEDICATED_CHANNELS

  return Strategy.DEFAULT
}
