# Welcome to Redis Oplog


### LICENSE: MIT

# This a clone of the original redis-oplog found [here](https://github.com/cult-of-coders/redis-oplog)

## First a Word of Thanks

[Theo](https://github.com/theodorDiaconu) has done the community a great service with redis-oplog. It has become a cornerstone of any major deployment of Meteor. This clone is a major improvement for highly / infinitely scalable Meteor apps. It does have less features (no Vent or SyntheticEvent) as it is optimized for a specific use-case that the original redis-oplog failed to address. We understand we are not the target audience so are grateful for the starting point.

## Problem Statement 
We were facing three major issues with the original redis-oplog

1. We faced major issues with redis-oplog in production on AWS Elatic-Beakstalk, out-of-memory & disconnects from redis. After some research we found that redis-oplog duplicates data (2x for each observer) and re-duplicates for each new observer (even if it's the same collection and same data)
2. DB hits were killing us, each update required multiple hits to update the data then pull it again. This is also another major negative -- not scalable and slow. The approach of keeping pulling from DB to get around the very rare race condition is unsustainable.
3. We want to read from MongoDB secondaries. The only way out with the current redis-oplog is (very) costly sharding.


## What we did
This version of redis-oplog is much simpler to use:

- Uses a single central timed cache at the collection-level, which is also the same place get data from when you run `findOne` / `find` -- so full data consistency within the app
- Uses redis to transmit changes to other instance caches -- consistency again
- During updates, we mutate the cache and send the changed fields to the DB and redis -- instead of the current find, update, then find again which has 2 more hits than needed (and is very slow)
- During inserts, we build the doc and send it to DB and other instances
- During removes, we send the ids to be removed to the DB and other instanes
- We use secondary DB reads in our app -- there are potential race conditions in extreme cases which we handle client-side for now; but we are now ready for scalability. If you have more reads --> spin up more secondaries
- Servers can now send data to each other's cache directly via a new feature called 'watchers'

## Ideas for future improvements
- Create LUA script to hold recent history of changes to get around rare race-conditions


## Installation


```bash
meteor add disable-oplog
```

In your \packages folder
```bash
git clone https://github.com/ramezrafla/redis-oplog.git
meteor add zegenie:redis-oplog
```

**Important**: Make sure zegenie:redis-oplog and disable-oplog are at the top of your meteor/.packages file

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
    "cacheTimer": 2700000,
    "debug": false, // Will show timestamp and activity of redis-oplog.
  }
}
```


```bash
meteor run --settings settings.json
```

## Notes

To make sure it is compatible with other packages which extend the `Mongo.Collection` methods, make sure you go to `.meteor/packages`
and put `zegenie:redis-oplog` as the first option.

RedisOplog does not work with _insecure_ package, which is used for bootstrapping your app.

### Events for Meteor (+ Redis Oplog, Grapher and GraphQL/Apollo)

*   Meteor Night 2018 Slide: [Arguments for Meteor](https://drive.google.com/file/d/1Tx9vO-XezO3DI2uAYalXPvhJ-Avqc4-q/view) - Theodor Diaconu, CEO of Cult of Coders: “Redis Oplog, Grapher, and Apollo Live.

## Premium Support

We are here to help. Feel free to contact us at ramez@classroomapp.com for this clone or contact@cultofcoders.com for the original version

## Contributors

This project exists thanks to all the people who contribute. [[Contribute]](CONTRIBUTING.md).
<a href="graphs/contributors"><img src="https://opencollective.com/redis-oplog/contributors.svg?width=890" /></a>

## Backers

Thank you to all our backers! 🙏 [[Become a backer](https://opencollective.com/redis-oplog#backer)]

<a href="https://opencollective.com/redis-oplog#backers" target="_blank"><img src="https://opencollective.com/redis-oplog/backers.svg?width=890"></a>

## Sponsors

Support this project by becoming a sponsor. Your logo will show up here with a link to your website. [[Become a sponsor](https://opencollective.com/redis-oplog#sponsor)]

<a href="https://opencollective.com/redis-oplog/sponsor/0/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/0/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/1/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/1/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/2/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/2/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/3/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/3/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/4/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/4/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/5/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/5/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/6/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/6/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/7/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/7/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/8/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/8/avatar.svg"></a>
<a href="https://opencollective.com/redis-oplog/sponsor/9/website" target="_blank"><img src="https://opencollective.com/redis-oplog/sponsor/9/avatar.svg"></a>

# redis-oplog
 