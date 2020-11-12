import getChannels from '../../cache/lib/getChannels'
import Config from '../../config'
import { DDP } from 'meteor/ddp'
import { _ } from 'meteor/underscore'

/**
 * @param collection
 * @param _config
 * @param mutationObject
 */
export default function (collection, _config) {
  if (!_config || typeof _config == 'function') _config = { }

  const defaultOverrides = { }

  if (!DDP._CurrentMethodInvocation.get()) {
    // If we're not in a method, then we can postpone sending to our obervers
    // Users can force by explicitly passing optimistic: true
    defaultOverrides.optimistic = false
  }

  const config = _.extend({}, Config.mutationDefaults, defaultOverrides, _config)

  config._channels = getChannels(collection._name, config)

  return config
}
