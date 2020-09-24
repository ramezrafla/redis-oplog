import { Items } from './collections';

if (Meteor.isServer) {
    Meteor.publish('collection_defaults.items', function(...args) {
        return Items.find(...args);
    });
}

Meteor.methods({
    'collection_defaults.items.insert'(...args) {
        return Items.insert(...args);
    },
    'collection_defaults.items.update'(...args) {
        return Items.update(...args);
    },
    'collection_defaults.items.remove'(...args) {
        return Items.remove(...args);
    },
});
