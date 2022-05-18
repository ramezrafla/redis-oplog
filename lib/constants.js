const RedisPipe = {
  EVENT: 'e',
  DOC: 'd',
  FIELDS: 'f',
  CLEARED: 'c', // fields cleared by $unset
  UID: 'u' // unique ID of the instance triggering the change
}

export default RedisPipe

const Events = {
  INSERT: 'i',
  UPDATE: 'u',
  REMOVE: 'r',
  FORCEUPDATE: 'fu',
  FORCEREMOVE: 'fr'
}

const Strategy = {
  DEFAULT: 'D',
  DEDICATED_CHANNELS: 'DC',
  LIMIT_SORT: 'LS'
}

const VentConstants = {
  ID: 'i',
  EVENT_VARIABLE: 'e',
  PREFIX: '__vent',
  getPrefix(id, name) {
      return `${id}.${name}`;
  }
}

export {
  Events,
  Strategy,
  RedisPipe,
  VentConstants
}
