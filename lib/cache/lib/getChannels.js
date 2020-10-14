import getChannelName from '../../utils/getChannelName'

export default (collectionName, {channel, channels}) => {
  const channelStrings = []

  if (channels) channels.forEach((name) => channelStrings.push(name))
  if (channel) channelStrings.push(channel)
  if (channelStrings.length === 0) channelStrings.push(collectionName)

  return channelStrings.map(getChannelName)
}
