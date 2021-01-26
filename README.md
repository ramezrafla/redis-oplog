# Welcome to the Scalable Redis Oplog
**Note**: This a clone of the original [redis-oplog](https://github.com/cult-of-coders/redis-oplog) to make it scalable


### LICENSE: MIT


## First a Word of Thanks

[Theo](https://github.com/theodorDiaconu) has done the community a great service with redis-oplog. It has become a cornerstone of any major deployment of Meteor. This clone is a major improvement for highly / infinitely scalable Meteor apps. It does have less features (no Vent or SyntheticEvent) as it is optimized for a specific use-case that the original redis-oplog failed to address. We understand we are not the target audience so are grateful for the starting point.

## Problem Statement 
We were facing three major issues with the original redis-oplog

1. We faced major issues with redis-oplog in production on AWS Elatic-Beakstalk, out-of-memory & disconnects from redis. After some research we found that redis-oplog duplicates data (2x for each observer) and re-duplicates for each new observer (even if it's the same collection and same data)
2. DB hits were killing us, each update required multiple hits to update the data then pull it again. This is also another major negative -- not scalable and slow. The approach of keeping pulling from DB to get around the very rare race condition is unsustainable.
3. We want to read from MongoDB secondaries to scale faster. The only way to properly scale with the current redis-oplog is (very) costly sharding.

In addition, the code was becoming complex and hard to understand (with dead code and need for optimization). This is owing to many hands getting involved and its aim to cover as many use cases as possible. **Such an important building-block for us had to be easily maintainable**.

## What we did
This version of redis-oplog is more streamlined:

- Uses a single central timed cache at the collection-level, which is also the same place that provides data for `findOne` / `find` -- so full data consistency within the app
- Uses redis to transmit changed (and cleared) fields (we do an actual diff) to other meteor instance caches -- consistency again and reduction of db hits as the meteor instances are 'helping' each other out
- During `update`, we mutate the cache and send the changed (and cleared) fields to the DB and redis -- instead of the current find, update, then find again which has 2 more hits than needed (which also slows down the application)
- During `insert`, we build the doc and send it via redis to other instances
- During `remove`, we send the ids to be removed to other instances
- We use secondary DB reads in our app. If you have more reads --> spin up more secondaries (Note: You don't have to use secondaries, just know that this package makes it possible)
- Optimized data sent via redis, only what REALLY changed 
- Added **Watchers** and **dynamic docs** (see advanced section below) 
- Added internal support for `collection-hooks` when caching (see Collection-hooks section below)
- Added a race conditions detector which queries the DB (master node) and updates its cache (read below)
 
In other words, this is not a Swiss-Army knife, it is made for a very specific purpose: **scalable read-intensive real-time application**

## Results

- We reduced the number of meteor instances by 3x
- No more out of memory and CPU spikes in Meteor -- stabler loads
- Faster updates (including to client) given fewer DB hits and less data sent to redis (and hence, the other meteor instances' load is reduced)
- We substantially reduced the load on our DB instances -- from 80% to 7% on primary (secondaries went up a bit, which is fine as they were idle anyway)

## Ideas for future improvements
- Support external redis publisher [`oplogtoredis`](https://github.com/tulip/oplogtoredis). A separate section below talks about this.
- Create formal Meteor package if there is interest by the community

## Installation


```bash
meteor add disable-oplog
```

In your `<root>/packages` folder
```bash
git clone https://github.com/ramezrafla/redis-oplog.git
meteor add zegenie:redis-oplog
```

**Important**: Make sure `zegenie:redis-oplog` is at the top of your `.meteor/packages` file

Configure it via Meteor settings:

```
// settings.json
{
    ...
    "redisOplog": {}
}

// default full configuration
{
  ...
  "redisOplog": {
    "redis": {
      "port": 6379, // Redis port
      "host": "127.0.0.1" // Redis host
    },
    "retryIntervalMs": 1000, // Retries in 1 second to reconnect to redis if the connection failed
    "mutationDefaults": {
        "optimistic": true, // Does not do a sync processing on the diffs. But it works by default with client-side mutations.
        "pushToRedis": true // Pushes to redis the changes by default
    },
    "cacheTimeout": 3600000, // Cache timeout, any data not accessed within that time is removed -- our default is 60 mins [READ BELOW BEFORE CHANGING]
    "cacheTimer": 600000, // at what interval do we check the cache for timeouts -- controls the granularity of cacheTimeout [READ BELOW BEFORE CHANGING]
    "secondaryReads": null, // Are you reading from secondary DB nodes
    "raceDetectionDelay": 1000, // How long until all mongo nodes are assumed to have been 
    "raceDetection": true, // set to null to automate this (see Race Conditions Detector below)
    "debug": false, // Will show timestamp and activity of redis-oplog
  }
}
```

```bash
meteor run --settings settings.json
```

## CacheTimeout and cacheTimer

- `cacheTimeout` (ms) is the max time a document can be unaccessed before it is deleted - default 60 minutes
- `cacheTimer` (ms) sets the delay of the `setTimeout` timer that checks cache documents' last access delay vs `cacheTimeout` - default 10 minutes

In other words, your worst-case delay before clearing a document is `cacheTimeout + cacheTimer`. Don't set `cacheTimer` too low so not to overload your server with frequent checks, set it too high and you overload your memory. 

Each project is different, so watch your memory usage to make sure your `cacheTimeout` does not bust your heap memory. It's a tradeoff, DB hits vs Meteor instance memory. Regardless, you are using way less memory than the original redis-oplog (which stored the same data for every different subscription)  - if you have large docs, see notes at end of this doc

## Secondary Reads

If you don't set `secondaryReads` to a Boolean value (`true`/`false`) we parse your `MONGO_URL`. 

This functionality affects two things:
1. Forces default strategy for limits (see below)
2. Automatically enables race conditions detection if `raceDetection` is null (useful if you want the same settings.json in development as in production)

## Race Conditions Detector

> You will see in your server logs `RedisOplog: RaceDetectionManager started` when it starts up

Given we are counting on internal caching (and potentially secondary reads) this detector is very important. It reads from your primary DB node (if you are reading from secondary nodes we will create a connector to your primary DB node) to fetch a clean copy of the document in the case where data is changing too fast to guarantee the cache is accurate. Observers will be triggered for changed values.

The setting `raceDetectionDelay` value is important, we check within that time window if the same fields were affected by a prior mutation. If so, we get the doc from the primary DB node. A crude collision detector is in place to prevent multiple meteor instances from making the same call. The one that does make the call will update all the other meteor nodes.

You will get a warning in the console like this: `Redios-Oplog: Potential race condition users-<_ID> [updatedAt, password]` which will indicate that we caught a potential race condition and are handling it (set `debug` to true to see the sequence of events)

> If you are facing weird data issues and suspect we are not catching all race conditions, set `raceDetectionDelay` to a very large value then see if that fixes it and watch your logs, you can then tweak the value for your setup

If you have fields that change often and you don't care about their value (e.g. `updatedAt`) you can disable race detection on the server at startup:
`this.collection.addRaceFieldsToIgnore(['updatedAt'])`

## Setup & basic usage

**Notes:** 
1. All setup is done server-side only, the following methods are not exposed client-side (nor should they be)
2. Please review the API section as well as the Important Notes section below


### Caching

In your code, for the collections you want to cache (which should really be most of your data):

`collection.startCaching()`

To get hits vs misses you can call the following method from your browser console in **development**

`Meteor.call('__getCollectionStats','myCollectionName',console.log)`

If you want to do this in production, copy the code at the bottom of `/lib/init.js` and add appropriate access controls.

This is sample data from our production servers for the `users` collection -- **99% hits!!**:
```
{
    hitRatio: 98.85108236349966
    hits: 6143833
    misses: 71408
}
```

**Note:** If you don't cache, you will still be hitting the DB like in the previous redis-oplog

### Disabling Redis

1. For **collections** for which you want to skip redis updates entirely (but you can still cache). This is useful for data that is needed for a given user only (in our case analytics collection) or large docs: `collection.disableRedis()`
2. For specific **mutations**: `collection.[update,insert,remove,upsert](<selector>,<modifier>, {pushToRedis:false} )`

### Collection-hooks

The package [collection-hooks](https://github.com/Meteor-Community-Packages/meteor-collection-hooks) is very popular as it allows you to call methods before / after DB calls. Unfortunately when caching a collection, this package causes collisions (as you may mutate DB-version of the doc, resulting in collision with cache). As such, we override the following methods to give you the same functionality as `collection-hooks` **only when the collection is cached - i.e. when you call `collection.startCaching()`**. Please refer to the original package for the signature of `cb` below:

```
collection.before.<find, findOne, insert, update, remove>(cb)
collection.after.<find, findOne, insert, update, remove>(cb)
collection.direct.<find, findOne, insert,update,remove>(cb)
```

**Notes:**
* We do not support `this.transform` & `this.previous` inside the callbacks as in the original package -- if it's needed, PRs are welcome
* We do not yet support `<before, after, direct>.upsert` -- not sure we ever well, pls PR if you need it

## Advanced Features

### Dynamic docs -- i.e. skipping DB write

```
collection.update(_id,{$set:{message:"Hello there!"}}, {skipDB:true} )
collection.insert({message:"Hello there!"}, {skipDB:true} )
```


This is useful for temporary changes that the client (and other Meteor instances) may need but should not go into the DB. This option is only available for `insert` and `update`:

1. For `remove` -- you can remove from cache directly with `deleteCache`
2. For `upsert` -- we count on the DB to validate if the doc exists so defeats the purpose of skipping DB

**Note: If skipping DB on `insert` and you don't provide `_id`, a random one will be created for consistency**

### Skipping Diffs

As mentioned, we do a diff vs the existing doc in the cache before we send out the `update` message to Redis and to the DB. This option avoids unnecesary hits to the DB and change messages to your other Meteor instances. This useful for cases where you don't want to diff (e.g. when you are sure the doc has changed or diff-ing can be computationally expensive)

`collection.update(_id,{$set:{message:"Hello there!"}}, {skipDiff:true} )`

> You can use skipDB and skipDiff together, there is no conflict


### Watchers - i.e. server-server updates

This is similar to Vents in the original `redis-oplog`. It allows updates to be sent to other Meteor instances directly. This is useful when
the data loop is closed -- you don't have any potential for updates elsewhere.

Here is a complete example to illustrate (only relevant code shown):

A user logs in with different clients (in our case the webapp and a Chrome extension). We don't want to be listening to expensive user-only DB changes for each user in two Meteor instances per user, especially when the data is well-known. So we send data back and forth between the Meteor instances where the user is logged in.


```
// we are only using dispatchInsert in the example below ... but you get the picture
import { 
  addToWatch, 
  removeFromWatch, 
  dispatchUpdate, 
  dispatchInsert, 
  dispatchRemove 
} from 'meteor/zegenie:redis-oplog'

const collection = new Mongo.Collection('messages')

// not necessary if you are only doing inserts as we send the full doc to redis
// but if you are doing updates, prevents DB queries
collection.startCaching()

onLogin = (userId) => {
    // first argument is the collection to affect / watch
    // second argument is the unique channel ID, we are using userId in our case
    addToWatch('messages', userId)
}

onMessage = (userId, text) => {
    const date = new Date()
    const _id = collection.insert({$set:{text, date, userId}})
    // first argument is the collection, second argument is the channel ID
    // IMPORTANT: doc HAS to include the document _id
    dispatchInsert('messages', userId, {_id, text, date})
}

onLogout = (userId) => {
    removeFromWatch('messages', userId)
}
```

### Forcing default update strategy -- (e.g. when using limits in cursors)

> Note: You need to know this if you are reading from secondary DB nodes

When a cursor has optiob `{limit:n}` redis-oplog has to query the DB at each change to get the current `n` valid documents. This is a killer in DB and app performance and often unnecessary from the client-side. You can disable this re-querying of the DB by forcing the `default` strategy

`collection.find({selector:value},{limit:n, sort:{...}, default:true} )`

This will run the first query from the DB with the limit and sort (and get `n` documents), but then behaves as a regular `find` from that point on (i.e. inserts, updates and removes that match the selector will trigger normal reactivity). This is likely to be sufficient most of the time. If you are reading from secondary DB nodes without this change, you WILL hit race conditions; you have updated the primary db node and are re-querying right away before secondaries get the data updates.

## API

### Setup
- `collection.startCaching(timeout)`: Sets up the database to start caching all documents that are seen through any DB `findOne`, `find`, `insert` and `update`. If `timeout` is provided it overrides `cacheTimeout` from settings
- `collection.disableRedis()`:  No updates are sent to redis from this collection **ever**, even if you set `{pushToRedis:true}`
- `collection.addRaceFieldsToIgnore(['updatedAt'])`: Defines fields to be ignored by the race conditions detector 

### Normal Usage
- `collection.getCache(id):<Object>`: Normally you would use `findOne`
- `collection.hasCache(id):Boolean`
- `collection.setCache(doc)`: Use carefully, as it overrides the entire doc, normally you would use `update`
- `collection.deleteCache(id or doc)`: Normally you would use `remove`
- `collection.clearCache(selector)`: Removes from cache all docs that match selector; if selector is empty clears the whole cache
- `addToWatch(collectionName, channelName)`: **See Watchers section above**
- `removeFromWatch(collectionName, channelName)`
- `dispatchInsert(collectionName, channelName, doc)`: Note that `doc` **has** to include `_id`
- `dispatchUpdate(collectionName, channelName, doc)`: Note that `doc` **has** to include `_id`
- `dispatchRemove(collectionName, channelName, docId)` or `dispatchRemove(collectionName, channelName, [docId1, docId2, ...])`

## Important Notes - MUST READ

- To make sure it is compatible with other packages which extend the `Mongo.Collection` methods, make sure you go to `.meteor/packages`
and put `zegenie:redis-oplog` as the first option.
- RedisOplog does not work with _insecure_ package, a warning is issued.
- Updates with **positional selectors** are done directly on the DB for now until this [PR](https://github.com/meteor/meteor/pull/9721) is pulled in. Just keep this in mind in terms of your db hits.
- This package **does not support ordered** observers. You **cannot** use `addedBefore`, `changedBefore` etc. This behavior is unlikely to change as it requires quite a bit of work and is not useful for the original developer. Frankly, you should use an `order` field in your doc and order at run-time / on the client.
- If you have **large documents**, caching could result in memory issues as we store the full document in the cache (for performance reasons, so we don't start matching missing fields etc. for the rare use case). You may need to tweak `cacheTimeout`. In such a use case I recommend you have a separate collection for these big fields and prevent caching on it or have shorter timeout. 

## OplogToRedis

The GO package [oplogtoredis](https://github.com/tulip/oplogtoredis) is an amazing tool which listens to the DB oplog and sends changes to redis. There is a problem, however. OplogToRedis only **sends the fields that have changed, not their final values** (like we do). We then have to pull from DB, hence negating our original intent to reduce db hits. Hopefully we'll have some updates on this (not urgent for us TBH). That being said, this is another point of failure vs. the original redis-oplog we can certainly live without.

## Premium Support

We are here to help. Feel free to contact us at ramez@classroomapp.com for this clone or contact@cultofcoders.com for the original version

## For Developers

The major areas that have seen changes from the original redis-oplog
- `mongo/extendMongoCollection`: Added support for caching
- `mongo/mutator`: Support for caching, removed sending the whole doc for the deprecated option `protectRaceConditions`, check which fields have REALLY changed and only send those, build inserts locally
- `mongo/observeMultiplex`: We now call on the cache to get the data, no more local caching of any data, uses projector to send the right fields down
- `cache/observableCollection`: No longer caching of data, just IDs; uses cache to build initial adds
- `redis/redisSubscriptionManager`: Many changes to support using Cache -- removed `getDoc` method
- `redis/watchManager` and `redis/customPublish`: New feature to allow server-server data transfers (see advanced section above)
- The redis signaling has been cleaned to remove unused keys (e.g. 'mt', 'id') and synthetic events (we now use watchers) and to include cleared fields ('c' -- i.e. $unset). For more details check `lib/constants`

Everywhere else, **major code cleanups** and removal of unused helpers in various `/lib` folders

## Contributors

This project exists thanks to all the people who contributed (to the original redis-oplog).
<a href="graphs/contributors"><img src="https://opencollective.com/redis-oplog/contributors.svg?width=890" /></a>

