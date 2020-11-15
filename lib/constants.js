const RedisPipe = {
  EVENT: 'e',
  DOC: 'd',
  FIELDS: 'f',
  CLEARED: 'c', // fields cleared by $unset
  UID: 'u' // this is the unique identity of a change request
}

export default RedisPipe

const Events = {
  INSERT: 'i',
  UPDATE: 'u',
  REMOVE: 'r'
}

const Strategy = {
  DEFAULT: 'D',
  DEDICATED_CHANNELS: 'DC',
  LIMIT_SORT: 'LS'
}

export {
  Events,
  Strategy,
  RedisPipe
}
