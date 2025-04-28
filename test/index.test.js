import {
  describe,
  it,
  beforeEach,
  afterEach,
  expect,
  vi,
  beforeAll,
  afterAll,
} from 'vitest'
import assert from 'assert'
import { map, random } from 'lodash'
import mongoose, { Schema } from 'mongoose'
import patchHistory, { RollbackError } from '../src'

describe('mongoose-patch-history', () => {
  const ObjectId = mongoose.Types.ObjectId
  const CommentSchema = new Schema({ text: String }).plugin(patchHistory, {
    mongoose,
    name: 'commentPatches',
    removePatches: false,
    includes: {
      text: {
        type: String,
      },
      user: {
        type: Schema.Types.ObjectId,
        required: true,
        from: '_user',
      },
    },
  })

  CommentSchema.virtual('user').set(function (user) {
    this._user = user
  })

  const PostSchema = new Schema(
    {
      title: String,
      tags: { type: [String], default: void 0 },
      active: { type: Boolean, default: false },
    },
    { timestamps: true }
  ).plugin(patchHistory, {
    mongoose,
    name: 'postPatches',
    transforms: [(name) => name.toLowerCase(), () => 'post_history'],
    includes: {
      version: { type: Number, from: '__v' },
      reason: { type: String, from: '__reason' },
      user: { type: Object, from: '__user' },
    },
  })
  PostSchema.virtual('user').set(function (user) {
    this.__user = user
  })
  PostSchema.virtual('reason').set(function (reason) {
    this.__reason = reason
  })

  const FruitSchema = new Schema({
    _id: { type: String, default: random(100).toString() },
    name: { type: String },
  }).plugin(patchHistory, { mongoose, name: 'fruitPatches' })

  const ExcludeSchema = new Schema({
    name: { type: String },
    hidden: { type: String },
    object: {
      hiddenProperty: { type: String },
      array: [
        { hidden: { type: String }, property: { hidden: { type: String } } },
      ],
    },
    array: [{ hiddenProperty: { type: String }, property: { type: String } }],
    emptyArray: [{ hiddenProperty: { type: String } }],
  }).plugin(patchHistory, {
    mongoose,
    name: 'excludePatches',
    excludes: [
      '/hidden',
      '/object/hiddenProperty',
      '/object/array/1/hidden',
      '/object/array/*/property/hidden',
      '/array/*/hiddenProperty',
      '/emptyArray/*/hiddenProperty',
    ],
  })

  const SportSchema = new Schema({
    _id: { type: Number, default: random(100) },
    name: { type: String },
  }).plugin(patchHistory, { mongoose, name: 'sportPatches' })

  const PricePoolSchema = new Schema({
    name: { type: String },
    prices: [{ name: { type: String }, value: { type: Number } }],
  }).plugin(patchHistory, {
    mongoose,
    name: 'pricePoolPatches',
    trackOriginalValue: true,
  })

  let Comment, Post, Fruit, Sport, User, PricePool, Exclude
  beforeAll(async () => {
    await mongoose.connect(
      'mongodb://root:root@localhost:27017/mongoose-patch-history'
    )

    const { connection } = mongoose
    await connection.db.dropDatabase()

    Comment = mongoose.model('Comment', CommentSchema)
    Post = mongoose.model('Post', PostSchema)
    Fruit = mongoose.model('Fruit', FruitSchema)
    Sport = mongoose.model('Sport', SportSchema)
    User = mongoose.model('User', new Schema({}))
    PricePool = mongoose.model('PricePool', PricePoolSchema)
    Exclude = mongoose.model('Exclude', ExcludeSchema)
  })

  afterAll(async () => {
    await mongoose.connection.close()
  })

  describe('initialization', () => {
    const name = 'testPatches'
    let TestSchema

    beforeEach(() => {
      TestSchema = new Schema()
    })

    it('throws when `mongoose` option is not defined', () => {
      expect(() => TestSchema.plugin(patchHistory, { name })).toThrow()
    })

    it('throws when `name` option is not defined', () => {
      expect(() => TestSchema.plugin(patchHistory, { mongoose })).toThrow()
    })

    it('throws when `data` instance method exists', () => {
      const DataSchema = new Schema()
      DataSchema.methods.data = () => {}
      expect(() =>
        DataSchema.plugin(patchHistory, { mongoose, name })
      ).toThrow()
    })

    it('does not throw with valid parameters', () => {
      expect(() =>
        TestSchema.plugin(patchHistory, {
          mongoose,
          name,
        })
      ).not.toThrow()
    })
  })

  describe('saving a new document', () => {
    it('adds a patch', async () => {
      // without referenced user
      const post = await Post.create({ title: 'foo' })
      const patches = await post.patches.find({ ref: post.id })

      expect(patches.length).toBe(1)
      expect(JSON.stringify(patches[0].ops)).toBe(
        JSON.stringify([
          { op: 'add', path: '/title', value: 'foo' },
          { op: 'add', path: '/active', value: false },
        ])
      )

      // with referenced user
      await User.findOne()
      const comment = await Comment.create({
        text: 'wat',
        user: new ObjectId(),
      })
      const commentPatches = await comment.patches.find({ ref: comment.id })

      expect(commentPatches.length).toBe(1)
      expect(JSON.stringify(commentPatches[0].ops)).toBe(
        JSON.stringify([{ op: 'add', path: '/text', value: 'wat' }])
      )
    })

    describe('with exclude options', () => {
      it('adds a patch containing no excluded properties', async () => {
        const exclude = await Exclude.create({
          name: 'exclude1',
          hidden: 'hidden',
          object: {
            hiddenProperty: 'hidden',
            array: [
              { hidden: 'h', property: { hidden: 'h' } },
              { hidden: 'h', property: { hidden: 'h' } },
              { hidden: 'h', property: { hidden: 'h' } },
            ],
          },
          array: [
            { hiddenProperty: 'hidden', property: 'visible' },
            { hiddenProperty: 'hidden', property: 'visible' },
          ],
          emptyArray: [{ hiddenProperty: 'hidden' }],
        })

        const patches = await exclude.patches.find({ ref: exclude._id })

        expect(patches.length).toBe(1)
        expect(JSON.stringify(patches[0].ops)).toBe(
          JSON.stringify([
            { op: 'add', path: '/name', value: 'exclude1' },
            {
              op: 'add',
              path: '/object',
              value: { array: [{ hidden: 'h' }, {}, { hidden: 'h' }] },
            },
            {
              op: 'add',
              path: '/array',
              value: [{ property: 'visible' }, { property: 'visible' }],
            },
            { op: 'add', path: '/emptyArray', value: [{}] },
          ])
        )
      })
    })
  })

  describe('saving an existing document', () => {
    it('with changes: adds a patch', async () => {
      const post = await Post.findOne({ title: 'foo' })
      post.set({
        title: 'bar',
        reason: 'test reason',
        user: { name: 'Joe' },
      })
      await post.save()

      const patches = await post.patches.find({ ref: post.id }).sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([{ op: 'replace', path: '/title', value: 'bar' }])
      )
      expect(patches[1].reason).toBe('test reason')
      expect(patches[1].user.name).toBe('Joe')
    })

    it('without changes: does not add a patch', async () => {
      const post = await Post.create({ title: 'baz' })
      await post.save()

      const patches = await post.patches.find({ ref: post.id })

      expect(patches.length).toBe(1)
    })

    it('with changes covered by exclude: does not add a patch', async () => {
      const exclude = await Exclude.findOne({ name: 'exclude1' })
      exclude.object.hiddenProperty = 'test'
      exclude.array[0].hiddenProperty = 'test'
      await exclude.save()

      const patches = await exclude.patches.find({ ref: exclude.id })

      expect(patches.length).toBe(1)
    })
  })

  describe('saving a document with custom _id type', () => {
    it('supports String _id types', async () => {
      const fruit = await Fruit.create({ name: 'apple' })
      const patches = await fruit.patches.find({ ref: fruit._id })

      expect(patches.length).toBe(1)
      expect(JSON.stringify(patches[0].ops)).toBe(
        JSON.stringify([{ op: 'add', path: '/name', value: 'apple' }])
      )
    })

    it('supports Number _id types', async () => {
      const sport = await Sport.create({ name: 'golf' })
      const patches = await sport.patches.find({ ref: sport._id })

      expect(patches.length).toBe(1)
      expect(JSON.stringify(patches[0].ops)).toBe(
        JSON.stringify([{ op: 'add', path: '/name', value: 'golf' }])
      )
    })
  })

  describe('updating a document via findOneAndUpdate()', () => {
    it('upserts a new document', async () => {
      await Post.findOneAndUpdate(
        { title: 'doesNotExist' },
        { title: 'findOneAndUpdate' },
        {
          upsert: true,
          new: true,
        }
      )

      const post = await Post.findOne({ title: 'findOneAndUpdate' })
      const patches = await post.patches
        .find({ ref: post._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(1)
      expect(JSON.stringify(patches[0].ops)).toBe(
        JSON.stringify([
          { op: 'add', path: '/title', value: 'findOneAndUpdate' },
          { op: 'add', path: '/active', value: false },
        ])
      )
    })

    it('with changes: adds a patch', async () => {
      const post = await Post.create({ title: 'findOneAndUpdate1' })
      await Post.findOneAndUpdate(
        { _id: post._id },
        { title: 'findOneAndUpdate2', __v: 1 },
        { __reason: 'test reason', __user: { name: 'Joe' } }
      )

      const patches = await post.patches
        .find({ ref: post._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([
          { op: 'replace', path: '/title', value: 'findOneAndUpdate2' },
        ])
      )
      expect(patches[1].reason).toBe('test reason')
      expect(patches[1].user.name).toBe('Joe')
    })

    it('without changes: does not add a patch', async () => {
      const post = await Post.findOneAndUpdate({ title: 'baz' }, {})
      const patches = await post.patches.find({ ref: post.id })

      expect(patches.length).toBe(1)
    })

    it('should not throw "TypeError: Cannot set property _original of null" error if doc does not exist', async () => {
      const post = await Post.findOneAndUpdate(
        { title: 'the_answer_to_life' },
        { title: '42', comments: 'thanks for all the fish' }
      )

      expect(post).toBe(null)
    })

    it('with options: { new: true }', async () => {
      const title = 'findOneAndUpdateNewTrue'
      await Post.create({ title })
      const post = await Post.findOneAndUpdate(
        { title },
        { title: 'baz' },
        { new: true }
      )
      const patches = await post.patches.find({ ref: post._id })

      expect(patches.length).toBe(2)
    })

    it('with options: { rawResult: true }', async () => {
      const title = 'findOneAndUpdateRawResultTrue'
      await Post.create({ title })
      const post = await Post.findOneAndUpdate(
        { title },
        { title: 'baz' },
        { rawResult: true }
      )

      const patches = await post.value.patches.find({ ref: post.value._id })

      expect(patches.length).toBe(2)
    })
  })

  describe('updating a document via updateOne()', () => {
    it('with changes: adds a patch', async () => {
      const post = await Post.create({ title: 'updateOne1' })
      await Post.updateOne({ _id: post._id }, { title: 'updateOne2' })

      const updatedPost = await Post.findOne({ title: 'updateOne2' })
      const patches = await updatedPost.patches
        .find({ ref: updatedPost._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([{ op: 'replace', path: '/title', value: 'updateOne2' }])
      )
    })

    it('without changes: does not add a patch', async () => {
      await Post.updateOne({ title: 'baz' }, {})
      const post = await Post.findOne({ title: 'baz' })
      const patches = await post.patches.find({ ref: post.id })

      expect(patches.length).toBe(1)
    })

    it('handles array filters', async () => {
      const pricePool = await PricePool.create({
        name: 'test',
        prices: [
          { name: 'test1', value: 1 },
          { name: 'test2', value: 2 },
        ],
      })

      await PricePool.updateMany(
        { name: pricePool.name },
        { $set: { 'prices.$[elem].value': 3 } },
        { arrayFilters: [{ 'elem.name': { $eq: 'test1' } }] }
      )

      const patches = await PricePool.Patches.find({})

      expect(patches.length).toBe(2)
    })
  })

  describe('updating a document via updateMany()', () => {
    it('with changes: adds a patch', async () => {
      const post = await Post.create({ title: 'updateMany1' })
      await Post.updateMany({ _id: post._id }, { title: 'updateMany2' })

      const posts = await Post.find({ title: 'updateMany2' })
      const patches = await posts[0].patches
        .find({ ref: posts[0]._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([
          { op: 'replace', path: '/title', value: 'updateMany2' },
        ])
      )
    })

    it('without changes: does not add a patch', async () => {
      await Post.updateMany({ title: 'baz' }, {})
      const posts = await Post.find({ title: 'baz' })
      const patches = await posts[0].patches.find({ ref: posts[0].id })

      expect(patches.length).toBe(1)
    })

    it('handles the $push operator', async () => {
      const post = await Post.create({ title: 'tagged1', tags: ['match'] })
      await Post.updateMany(
        { _id: post._id },
        { $push: { tags: 'match2' } },
        { timestamps: false }
      )

      const posts = await Post.find({ title: 'tagged1' })
      const patches = await posts[0].patches
        .find({ ref: posts[0]._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([{ op: 'add', path: '/tags/1', value: 'match2' }])
      )
    })

    it('handles the $pull operator', async () => {
      await Post.create({ title: 'tagged2', tags: ['match'] })
      // Remove the 'match' tag from all posts tagged with 'match'
      await Post.updateMany(
        { tags: 'match' },
        { $pull: { tags: 'match' } },
        { timestamps: false }
      )

      const posts = await Post.find({ title: 'tagged2' })
      const patches = await posts[0].patches
        .find({ ref: posts[0]._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([{ op: 'remove', path: '/tags/0' }])
      )
    })
  })

  describe('upsert a document', () => {
    it('with changes: adds a patch', async () => {
      await Post.updateMany(
        { title: 'upsert0' },
        { title: 'upsert1' },
        { upsert: true, multi: true }
      )

      const posts = await Post.find({ title: 'upsert1' })
      const patches = await posts[0].patches
        .find({ ref: posts[0]._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(1)
      expect(JSON.stringify(patches[0].ops)).toBe(
        JSON.stringify([
          { op: 'add', path: '/title', value: 'upsert1' },
          { op: 'add', path: '/active', value: false },
        ])
      )
    })

    it('without changes: does not add a patch', async () => {
      await Post.updateMany(
        { title: 'upsert1' },
        { title: 'upsert1' },
        { upsert: true, multi: true }
      )

      const posts = await Post.find({ title: 'upsert1' })
      const patches = await posts[0].patches.find({ ref: posts[0].id })

      expect(patches.length).toBe(1)
    })

    it('with updateMany: adds a patch', async () => {
      await Post.updateMany(
        { title: 'upsert2' },
        { title: 'upsert3' },
        { upsert: true }
      )

      const posts = await Post.find({ title: 'upsert3' })
      const patches = await posts[0].patches.find({ ref: posts[0].id })

      expect(patches.length).toBe(1)
    })
  })

  describe('update with multi', () => {
    it('should not throw "TypeError: Cannot set property _original of null" error if doc does not exist', async () => {
      await Post.updateMany(
        { title: { $in: ['foo_bar'] } },
        { title: 'bar_foo' },
        { multi: true, upsert: false }
      )
    })
  })

  describe('removing a document', () => {
    it('removes all patches', async () => {
      const post = await Post.findOne({ title: 'bar' })
      await post.remove()

      const patches = await post.patches.find({ ref: post.id })

      expect(patches.length).toBe(0)
    })

    it("doesn't remove patches when `removePatches` is false", async () => {
      const comment = await Comment.findOne({ text: 'wat' })
      await comment.remove()

      const patches = await comment.patches.find({ ref: comment.id })

      expect(patches.length).toBe(1)
    })

    it('removes all patches via findOneAndRemove()', async () => {
      const post = await Post.create({ title: 'findOneAndRemove1' })
      const removedPost = await Post.findOneAndRemove({ _id: post.id })

      const patches = await removedPost.patches.find({ ref: removedPost.id })

      expect(patches.length).toBe(0)
    })
  })

  describe('rollback', () => {
    it('with unknown id is rejected', async () => {
      const post = await Post.create({ title: 'version 1' })

      await expect(post.rollback(ObjectId())).rejects.toThrow(RollbackError)
    })

    it('to latest patch is rejected', async () => {
      const post = await Post.create({ title: 'version 1' })
      const latestPatch = await post.patches.findOne({ ref: post.id })

      await expect(post.rollback(latestPatch.id)).rejects.toThrow(RollbackError)
    })

    it('adds a new patch and updates the document', async () => {
      let c = await Comment.create({ text: 'comm 1', user: ObjectId() })
      c = await Comment.findOne({ _id: c.id })
      c = await c.set({ text: 'comm 2', user: ObjectId() }).save()
      c = await Comment.findOne({ _id: c.id })
      c = await c.set({ text: 'comm 3', user: ObjectId() }).save()
      c = await Comment.findOne({ _id: c.id })

      const patches = await c.patches.find({ ref: c.id })
      c = await c.rollback(patches[1].id, { user: ObjectId() })

      expect(c.text).toBe('comm 2')
      const finalPatches = await c.patches.find({ ref: c.id })
      expect(finalPatches.length).toBe(4)
    })

    it("updates but doesn't save the document", async () => {
      let c = await Comment.create({ text: 'comm 1', user: ObjectId() })
      c = await Comment.findOne({ _id: c.id })
      c = await c.set({ text: 'comm 2', user: ObjectId() }).save()
      c = await Comment.findOne({ _id: c.id })
      c = await c.set({ text: 'comm 3', user: ObjectId() }).save()
      c = await Comment.findOne({ _id: c.id })

      const patches = await c.patches.find({ ref: c.id })
      c = await c.rollback(patches[1].id, { user: ObjectId() }, false)

      expect(c.text).toBe('comm 2')
      const dbC = await Comment.findOne({ _id: c.id })
      expect(dbC.text).toBe('comm 3')

      const finalPatches = await c.patches.find({ ref: c.id })
      expect(finalPatches.length).toBe(3)
    })
  })

  describe('model and collection names', () => {
    const getCollectionNames = async () => {
      return new Promise((resolve, reject) => {
        mongoose.connection.db.listCollections().toArray((err, collections) => {
          if (err) {
            return reject(err)
          }
          resolve(map(collections, 'name'))
        })
      })
    }

    it('pascalize for model and decamelize for collection', async () => {
      expect(mongoose.modelNames().includes('CommentPatches')).toBe(true)
      const names = await getCollectionNames()
      expect(names.includes('comment_patches')).toBe(true)
    })

    it('uses `transform` option when set', async () => {
      expect(mongoose.modelNames().includes('postPatches')).toBe(true)
      const names = await getCollectionNames()
      expect(names.includes('post_history')).toBe(true)
    })
  })

  describe('timestamps', () => {
    it('creates doc and sets mongoose timestamp fields', async () => {
      const post = await Post.create({ title: 'ts1' })
      const patches = await post.patches
        .find({ ref: post._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(1)
      expect(patches[0].date.toUTCString()).toBe(post.createdAt.toUTCString())
      expect(patches[0].date.toUTCString()).toBe(post.updatedAt.toUTCString())
    })

    it('updates doc and sets mongoose timestamp fields', async () => {
      const { _id } = await Post.create({ title: 'ts2' })
      await Post.updateOne({ _id }, { $set: { title: 'ts2.1' } })

      const post = await Post.findOne({ title: 'ts2.1' })
      const patches = await post.patches
        .find({ ref: post._id })
        .sort({ _id: 1 })

      expect(patches.length).toBe(2)
      expect(patches[0].date.toUTCString()).toBe(post.createdAt.toUTCString())
      expect(patches[1].date.toUTCString()).toBe(post.updatedAt.toUTCString())
    })
  })

  describe('jsonpatch.compare', () => {
    let Organization
    let Person

    beforeAll(() => {
      Organization = mongoose.model(
        'Organization',
        new mongoose.Schema({
          name: String,
        })
      )

      const PersonSchema = new mongoose.Schema({
        name: String,
        organization: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Organization',
        },
      })

      PersonSchema.plugin(patchHistory, { mongoose, name: 'personPatches' })
      Person = mongoose.model('Person', PersonSchema)
    })

    it('is able to handle ObjectId references correctly', async () => {
      const o1 = await Organization.create({ text: 'Home' })
      const o2 = await Organization.create({ text: 'Work' })
      let p = await Person.create({ name: 'Bob', organization: o1._id })
      p = await p.set({ organization: o2._id }).save()

      const patches = await p.patches.find({ ref: p.id })

      const pathFilter = (path) => (elem) => elem.path === path
      const firstOrganizationOperation = patches[0].ops.find(
        pathFilter('/organization')
      )
      const secondOrganizationOperation = patches[1].ops.find(
        pathFilter('/organization')
      )

      expect(patches.length).toBe(2)
      expect(firstOrganizationOperation).toBeTruthy()
      expect(secondOrganizationOperation).toBeTruthy()
      expect(firstOrganizationOperation.value).toBe(o1._id.toString())
      expect(secondOrganizationOperation.value).toBe(o2._id.toString())
    })
  })

  describe('track original values', () => {
    let Company

    beforeAll(() => {
      const CompanySchema = new mongoose.Schema({
        name: String,
      })

      CompanySchema.plugin(patchHistory, {
        mongoose,
        name: 'companyPatches',
        trackOriginalValue: true,
      })
      Company = mongoose.model('Company', CompanySchema)
    })

    afterAll(async () => {
      await Promise.all([
        Company.deleteMany({}),
        Company.Patches.deleteMany({}),
      ])
    })

    it('stores the original value in the ops entries', async () => {
      let c = await Company.create({ text: 'Private' })
      c = await c.set({ name: 'Private 2' }).save()
      c = await c.set({ name: 'Private 3' }).save()

      const patches = await c.patches.find()

      expect(patches.length).toBe(2)
      expect(JSON.stringify(patches[1].ops)).toBe(
        JSON.stringify([
          {
            op: 'replace',
            path: '/name',
            value: 'Private 3',
            originalValue: 'Private 2',
          },
        ])
      )
    })
  })
})
