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
This version of redis-oplog is more streamlined (you can see this with the reduced number of settings):

- Uses a single central timed cache at the collection-level, which is also the same place that provides data for `findOne` / `find` -- so full data consistency within the app
- Uses redis to transmit changed (and cleared) fields (we do an actual diff) to other instance caches -- consistency again
- During `update`, we mutate the cache and send the changed (and cleared) fields to the DB and redis -- instead of the current find, update, then find again which has 2 more hits than needed (and is very slow)
- During `insert`, we build the doc and send it via redis to other instances
- During `remove`, we send the ids to be removed to other instances
- We use secondary DB reads in our app -- there are potential race conditions in extreme cases which we handle client-side for now; but we are now ready for scalability. If you have more reads --> spin up more secondaries
- Optimized data sent via redis, only what REALLY changed 
- Added **Watchers** and **dynamic docs** (see advanced section below) 

In other words, this is not a Swiss-Army knife, it is made for a very specific purpose: **scalable read-intensive real-time application**

## Results

- We reduced the number of meteor instances by 3x
- No more out of memory and CPU spikes in Meteor -- stabler loads
- Faster updates (including to client) given fewer DB hits and less data sent to redis (and hence, the other meteor instances' load is reduced)
- We substantially reduced the load on our DB instances -- from 80% to 7% on primary (secondaries went up a bit, which is fine as they were idle anyway)

## Ideas for future improvements
- Create LUA script for Redis to hold recent history of changes to get around rare race-conditions
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
    "cacheTimeout": 3600000, // Cache timeout, any data not accessed within that time is removed -- our default is 60 mins
    "cacheTimer": 600000, // at what interval do we check the cache for timeouts -- controls the granularity of cacheTimeout
    "debug": false, // Will show timestamp and activity of redis-oplog
  }
}
```

```bash
meteor run --settings settings.json
```

### A note about cacheTimeout and cacheTimer

- `cacheTimeout` (ms) is the max time a document can be unaccessed before it is deleted - default 60 minutes
- `cacheTimer` (ms) sets the delay in the `setTimeout` timer that checks cache documents' last access delay - default 10 minutes

In other words, your worst-case delay before clearing a document is `cacheTimeout + cacheTimer`. Don't set `cacheTimer` too low so not to overload your server with frequent checks, set it too high and you overload your memory. Default is 10 minutes.

Each project is different, so watch your memory usage to make sure your `cacheTimeout` does not bust your heap memory. It's a tradeoff, DB hits vs Meteor instance memory. Regardless, you are using way less memory than the original redis-oplog as there is no duplication of docs (exception: if you have large docs, see notes at end of this doc)

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

1. For **collections** for which you want to skip redis updates entirely (but you can still cache). This is useful for data that is useful for a given user only (in our case analytics collection) or large docs: `collection.disableRedis()`
2. For specific **mutations**: `collection.[update,insert,remove,upsert](<selector>,<modifier>, {pushToRedis:false} )`

### Collection-hooks

The package [collection-hooks](https://github.com/Meteor-Community-Packages/meteor-collection-hooks) is very popular as it allows you to call methods before / after DB calls. Unfornutately when caching a collection, this package causes collisions (as it counts on direct access to the DB, which may result in cached docs being different from DB docs). As such, we override the following methods to give you the same functionality as `collection-hooks` **only when the collection is cached - i.e. when you call `collection.startCaching()`**. Please refer to the original package for the signature of `cb` below:

```
collection.before.<find, findOne, insert, update, remove>(cb)
collection.after.<find, findOne, insert, update, remove>(cb)
collection.direct.<find, findOne, insert,update,remove>(cb)
```
**Notes:**
* We do not support `this.transform` & `this.previous` inside the callbacks as in the original package
* We do not yet support `<before, after, direct>.upsert` -- not sure we ever well, pls PR if you need it

## Advanced Features

### Dynamic docs -- i.e. skipping DB write

```
collection.update(_id,{$set:{message:"Hello there!"}}, {skipDB:true} )
collection.insert({message:"Hello there!"}, {skipDB:true} )
```


This is useful for temporary changes that the client (and other Meteor instances) may need but should not go into the DB. This option is only available for `insert` and `update` only:

1. For `remove` -- remove from cache directly with `deleteCache`
2. For `upsert` -- we count on the DB to validate if the doc exists

**Note: If skipping DB on `insert` and you don't provide `_id`, a random one will be created for consistency**

### Skipping Diffs

As mentioned, we do a diff vs the existing doc in the cache before we send out the `update` message to Redis and to the DB. This avoids unnecesary hits to the DB and change messages to your other Meteor instances (and reduces your code complexity). There are cases where you don't want to diff (e.g. when you are sure the doc has changed or diff-ing can be expensive)

`collection.update(_id,{$set:{message:"Hello there!"}}, {skipDiff:true} )`

> You can use skipDB and skipDiff together, there is no conflict


### Watchers - i.e. server-server updates

This is similar to vents in the original `redis-oplog`. It allows updates to be sent to other Meteor instances directly. This is useful when
the data loop is closed -- you don't have any potential for updates elsewhere.

Here is a complete example to illustrate (only relevant code shown):

A user logs in with different clients (in our case the webapp and a Chrome extension). We don't want to be listening to expensive DB changes for each user in two Meteor instances per user, especially when the data is well-known. So we send data back and forth between the Meteor instances where the user is logged in.


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
    // we are using userId as the channel ID
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

Meteor.publish('messages', function() {
    return collection.find({userId:this.userId}, {fields:{text:1, date:1})  
})
```

### Forcing default update strategy -- (e.g. when using limits in cursors)

> Note: You need to know this if you are reading from secondary DB nodes

When a cursor has `{limit:n}` redis-oplog has to query the DB at each change to get the current `n` valid documents. This is a killer in DB and app performance and often unnecessary from the client-side. You can disable this re-querying of the DB by forcing the `default` strategy

`collection.find({selector:value},{limit:n, sort:{...}, default:true} )`

This will do the first query from the DB with the limit and sort (and get `n` documents), but then behaves as a regular `find` from that point on (i.e. inserts, updates and removes that meet the selector will trigger normal reactivity). This is likely to be sufficient most of the time. If you are reading from secondary DB nodes without this change, you may hit race conditions; you have updated the primary db node and are re-querying right away before secondaries may have had the change to get the data updates.

## API

- `collection.startCaching(timeout)`: Sets up the database to start caching all documents that are seen through any DB `findOne`, `find`, `insert` and `update`. If `timeout` is provided it overrides `cacheTimeout` from settings
- `collection.disableRedis()`:  No updates are sent to redis from this collection **ever**, even if you set `{pushToRedis:true}`
- `collection.getCache(id):<Object>`: Avoid, use `findOne` if you can, as this function clones the entire doc
- `collection.hasCache(id):Boolean`
- `collection.setCache(doc)`: Use carefully, as it overrides the entire doc
- `collection.deleteCache(id or doc)`: Again, avoid if you can. Use `collection.remove` instead
- `collection.clearCache(selector)`: Removes from cache all docs that match selector; if selector is empty clears the whole cache
- `collection.mergeDocs(docs:Array.<Objects>)`: if a doc is not in the cache we load it INTO the cache, if it is in the cache we **override** it in passed docs array (i.e. cache always **prevails** otherwise pull from DB). 
- `collection.fetchInCacheFirst(ids:Array.<String>)`: Pull from cache first, otherwise gets from DB
- `addToWatch(collectionName, channelName)`: **See Watchers section above**
- `removeFromWatch(collectionName, channelName)`
- `dispatchInsert(collectionName, channelName, doc)`: Note that `doc` **has** to include `_id`
- `dispatchUpdate(collectionName, channelName, doc)`: Note that `doc` **has** to include `_id`
- `dispatchRemove(collectionName, channelName, docId)` or `dispatchRemove(collectionName, channelName, [docId1, docId2, ...])`

## Important Notes - MUST READ

- To make sure it is compatible with other packages which extend the `Mongo.Collection` methods, make sure you go to `.meteor/packages`
and put `zegenie:redis-oplog` as the first option.
- RedisOplog does not work with _insecure_ package.
- Updates with **positional selectors** are done directly on the DB for now until this [PR](https://github.com/meteor/meteor/pull/9721) is pulled in. Just keep this in mind in terms of your db hits.
- This package **does not support ordered** observers. You **cannot** use `addedBefore`, `changedBefore` etc. This behavior is unlikely to change as it requires quite a bit of work and is not useful for the original developer. Frankly, you should use an `order` field in your doc and order at run-time / on the client.
- If you have **large documents**, caching could result in memory issues as we store the full document in the cache. You may need to tweak `cacheTimeout`. In such a use case you should have a separate collection for these big fields and prevent caching on it or have shorter timeout. (Note: adding the option to exclude certain fields from being cached will result in undue complexity for a rare use case)

## OplogToRedis

The GO package [oplogtoredis](https://github.com/tulip/oplogtoredis) is an amazing tool which listens to the DB oplog and sends changes to redis. There is a problem, however. OplogToRedis only sends the fields that have changed, not their new values (like we do). We then have to pull from DB, hence negating our original intent to reduce db hits. Hopefully we'll have some updates on this (not urgent for us TBH). That being said, this is another point of failure we can live without.

## Premium Support

We are here to help. Feel free to contact us at ramez@classroomapp.com for this clone or contact@cultofcoders.com for the original version

## For Developers

The major areas that have seen changes from the original redis-oplog
- `mongo/extendMongoCollection`: Added support for caching
- `mongo/Mutator`: Support for caching, removed sending the whole doc for the deprecated option `protectRaceConditions`, check which fields have REALLY changed and only send those, build inserts locally
- `mongo/ObserveMultiplex`: We now call on the cache to get the data, no more local caching of any data, uses projector to send the right fields down
- `cache/ObservableCollection`: No longer caching of data, just IDs; uses cache to build initial adds
- `redis/RedisSubscriptionManager`: Many changes to support using Cache -- removed `getDoc` method
- `redis/WatchManager` and `redis/CustomPublish`: New feature to allow server-server data transfers (see advanced section above)
- The redis signaling has been cleaned to remove unused keys (e.g. 'mt', 'id') and synthetic events (we now use watchers) and to include cleared fields ('c' -- i.e. $unset). For more details check `lib/constants`

Everywhere else, **major code cleanups** and removal of unused helpers in various `/lib` folders

## Contributors

This project exists thanks to all the people who contributed (to the original redis-oplog).
<a href="graphs/contributors"><img src="https://opencollective.com/redis-oplog/contributors.svg?width=890" /></a>

