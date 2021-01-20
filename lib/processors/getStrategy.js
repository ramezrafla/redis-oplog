import { Strategy } from '../constants'
import Config from '../config'


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
    // to avoid race conditions when requerying
    if (Config.secondaryReads) return Strategy.DEFAULT
    return Strategy.LIMIT_SORT
  }

  if (selector && selector._id) return Strategy.DEDICATED_CHANNELS

  return Strategy.DEFAULT
}
