<p align="center"><img title="redux-active" src="docs/mongoose-patch-history.png" width="519" style="margin-top:20px;"></p>

[![npm version](https://badge.fury.io/js/mongoose-patch-history.svg)](https://badge.fury.io/js/mongoose-patch-history) [![Build Status](https://travis-ci.org/codepunkt/mongoose-patch-history.svg?branch=master)](https://travis-ci.org/codepunkt/mongoose-patch-history) [![Greenkeeper badge](https://badges.greenkeeper.io/codepunkt/mongoose-patch-history.svg)](https://greenkeeper.io/) [![Known Vulnerabilities](https://snyk.io/test/github/codepunkt/mongoose-patch-history/badge.svg)](https://snyk.io/test/github/codepunkt/mongoose-patch-history:package.json?targetFile=package.json) [![Coverage Status](https://coveralls.io/repos/github/codepunkt/mongoose-patch-history/badge.svg?branch=master)](https://coveralls.io/github/codepunkt/mongoose-patch-history?branch=master)

Mongoose Patch History is a mongoose plugin that saves a history of [JSON Patch](http://jsonpatch.com/) operations for all documents belonging to a schema in an associated "patches" collection.

## Installation

    $ npm install mongoose-patch-history

## Usage

To use **mongoose-patch-history** for an existing mongoose schema you can simply plug it in. As an example, the following schema definition defines a `Post` schema, and uses mongoose-patch-history with default options:

```javascript
import mongoose, { Schema } from 'mongoose'
import patchHistory from 'mongoose-patch-history'

/* or the following if not running your app with babel:
const patchHistory = require('mongoose-patch-history').default;
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
*/

const PostSchema = new Schema({
  title: { type: String, required: true },
  comments: Array,
})

PostSchema.plugin(patchHistory, { mongoose, name: 'postPatches' })
const Post = mongoose.model('Post', PostSchema)
```

**mongoose-patch-history** will define a schema that has a `ref` field containing the `ObjectId` of the original document, a `ops` array containing all json patch operations and a `date` field storing the date where the patch was applied.

### Storing a new document

Continuing the previous example, a new patch is added to the associated patch collection whenever a new post is added to the posts collection:

```javascript
// Using async/await
const post = await Post.create({ title: 'JSON patches' });
const patch = await post.patches.findOne({ ref: post.id });
console.log(patch);

// {
//   _id: ObjectId('4edd40c86762e0fb12000003'),
//   ref: ObjectId('4edd40c86762e0fb12000004'),
//   ops: [
//     { value: 'JSON patches', path: '/title', op: 'add' },
//     { value: [], path: '/comments', op: 'add' }
//   ],
//   date: new Date(1462360838107),
//   __v: 0
// }
```

### Updating an existing document

**mongoose-patch-history** also adds a static field `Patches` to the model that can be used to access the patch model associated with the model, for example to query all patches of a document. Whenever a post is edited, a new patch that reflects the update operation is added to the associated patch collection:

```javascript
const data = {
  title: 'JSON patches with mongoose',
  comments: [{ message: 'Wow! Such Mongoose! Very NoSQL!' }],
}

// Using async/await
const post = await Post.create({ title: 'JSON patches' });
await post.set(data).save();
const patches = await post.patches.find({ ref: post.id });
console.log(patches);

// [{
//   _id: ObjectId('4edd40c86762e0fb12000003'),
//   ref: ObjectId('4edd40c86762e0fb12000004'),
//   ops: [
//     { value: 'JSON patches', path: '/title', op: 'add' },
//     { value: [], path: '/comments', op: 'add' }
//   ],
//   date: new Date(1462360838107),
//   __v: 0
// }, {
//   _id: ObjectId('4edd40c86762e0fb12000005'),
//   ref: ObjectId('4edd40c86762e0fb12000004'),
//   ops: [
//     { value: { message: 'Wow! Such Mongoose! Very NoSQL!' }, path: '/comments/0', op: 'add' },
//     { value: 'JSON patches with mongoose', path: '/title', op: 'replace' }
//   ],
//   "date": new Date(1462361848742),
//   "__v": 0
// }]
```

### Rollback to a specific patch

```javascript
await rollback(ObjectId, data, save)
```

Documents have a `rollback` method that accepts the _ObjectId_ of a patch doc and sets the document to the state of that patch, adding a new patch to the history.

```javascript
// Using async/await syntax
const post = await Post.create({ title: 'First version' });
post.set({ title: 'Second version' });
await post.save();
post.set({ title: 'Third version' });
await post.save();

const patches = await post.patches.find({ ref: post.id });
const rolledBackPost = await post.rollback(patches[1].id);
console.log(rolledBackPost);

// {
//   _id: ObjectId('4edd40c86762e0fb12000006'),
//   title: 'Second version',
//   __v: 0
// }
```

#### Injecting data

Further the `rollback` method accepts a _data_ object which is injected into the document.

```javascript
post.rollback(patches[1].id, { name: 'merged' })

// {
//   _id: ObjectId('4edd40c86762e0fb12000006'),
//   title: 'Second version',
//   name: 'merged',
//   __v: 0
// }
```

#### Rollback without saving

To `rollback` the document to a specific patch but without saving it back to the database call the method with an empty _data_ object and the save flag set to false.

```javascript
post.rollback(patches[1].id, {}, false)

// Returns the document without saving it back to the db.
// {
//   _id: ObjectId('4edd40c86762e0fb12000006'),
//   title: 'Second version',
//   __v: 0
// }
```

The `rollback` method will throw an Error when invoked with an ObjectId that is

- not a patch of the document
- the latest patch of the document

## Options

```javascript
PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
})
```

- `mongoose` :pushpin: _required_ <br/>
  The mongoose instance to work with
- `name` :pushpin: _required_ <br/>
  String where the names of both patch model and patch collection are generated from. By default, model name is the pascalized version and collection name is an undercore separated version
- `removePatches` <br/>
  Removes patches when origin document is removed. Default: `true`
- `transforms` <br/>
  An array of two functions that generate model and collection name based on the `name` option. Default: An array of [humps](https://github.com/domchristie/humps).pascalize and [humps](https://github.com/domchristie/humps).decamelize
- `includes` <br/>
  Property definitions that will be included in the patch schema. Read more about includes in the next chapter of the documentation. Default: `{}`
- `excludes` <br/>
  Property paths that will be excluded in patches. Read more about excludes in the [excludes chapter of the documentation](https://github.com/codepunkt/mongoose-patch-history#excludes). Default: `[]`
- `trackOriginalValue` <br/>
  If enabled, the original value will be stored in the change patches under the attribute `originalValue`. Default: `false`

### Includes

```javascript
PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
  includes: {
    title: { type: String, required: true },
  },
})
```

This will add a `title` property to the patch schema. All options that are available in mongoose's schema property definitions such as `required`, `default` or `index` can be used.

```javascript
Post.create({ title: 'Included in every patch' })
  .then((post) => post.patches.findOne({ ref: post.id })
  .then((patch) => {
    console.log(patch.title) // 'Included in every patch'
  })
```

The value of the patch documents properties is read from the versioned documents property of the same name.

#### Reading from virtuals

There is an additional option that allows storing information in the patch documents that is not stored in the versioned documents. To do so, you can use a combination of [virtual type setters](http://mongoosejs.com/docs/guide.html#virtuals) on the versioned document and an additional `from` property in the include options of **mongoose-patch-history**:

```javascript
// save user as _user in versioned documents
PostSchema.virtual('user').set(function (user) {
  this._user = user
})

// read user from _user in patch documents
PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
  includes: {
    user: { type: Schema.Types.ObjectId, required: true, from: '_user' },
  },
})

// create post, pass in user information
Post.create({
  title: 'Why is hiring broken?',
  user: mongoose.Types.ObjectId(),
})
  .then(post => {
    console.log(post.user) // undefined
    return post.patches.findOne({ ref: post.id })
  })
  .then(patch => {
    console.log(patch.user) // 4edd40c86762e0fb12000012
  })
```

In case of a rollback in this scenario, the `rollback` method accepts an [object as its second parameter](https://github.com/codepunkt/mongoose-patch-history#injecting-data) where additional data can be injected:

```javascript
Post.create({ title: 'v1', user: mongoose.Types.ObjectId() })
  .then(post =>
    post
      .set({
        title: 'v2',
        user: mongoose.Types.ObjectId(),
      })
      .save()
  )
  .then(post => {
    return post.patches.find({ ref: post.id }).then(patches =>
      post.rollback(patches[0].id, {
        user: mongoose.Types.ObjectId(),
      })
    )
  })
```

#### Reading from query options

In situations where you are running Mongoose queries directly instead of via a document, you can specify the extra fields in the query options:

```javascript
Post.findOneAndUpdate(
  { _id: '4edd40c86762e0fb12000012' },
  { title: 'Why is hiring broken? (updated)' },
  { _user: mongoose.Types.ObjectId() }
)
```

### Excludes

```javascript
PostSchema.plugin(patchHistory, {
  mongoose,
  name: 'postPatches',
  excludes: [
    '/path/to/hidden/property',
    '/path/into/array/*/property',
    '/path/to/one/array/1/element',
  ],
})

// Properties
// /path/to/hidden:                   included
// /path/to/hidden/property:          excluded
// /path/to/hidden/property/nesting:  excluded

// Array element properties
// /path/into/array/0:                included
// /path/into/array/345345/property:  excluded
// /path/to/one/array/0/element:      included
// /path/to/one/array/1/element:      excluded
```

This will exclude the given properties and _all nested_ paths. Excluding `/` however will not work, since then you can just disable the plugin.

- If a property is `{}` or `undefined` after processing all excludes statements, it will _not_ be included in the patch.
- Arrays work a little different. Since json-patch-operations work on the array index, array elements that are `{}` or `undefined` are still added to the patch. This brings support for later `remove` or `replace` operations to work as intended.<br/>
  The `ARRAY_WILDCARD` `*` matches every array element.

If there are any bugs experienced with the `excludes` feature please write an issue so we can fix it!
