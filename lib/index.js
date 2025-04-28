"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.RollbackError = void 0;
exports.default = _default;
var _assert = _interopRequireDefault(require("assert"));
var _fastJsonPatch = _interopRequireDefault(require("fast-json-patch"));
var _humps = require("humps");
var _lodash = require("lodash");
var _mongoose = require("mongoose");
function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }
const RollbackError = function (message /*, extra */) {
  Error.captureStackTrace(this, this.constructor);
  this.name = 'RollbackError';
  this.message = message;
};
exports.RollbackError = RollbackError;
require('util').inherits(RollbackError, Error);
const createPatchModel = options => {
  const def = {
    date: {
      type: Date,
      required: true,
      default: Date.now
    },
    ops: {
      type: [],
      required: true
    },
    ref: {
      type: options._idType,
      required: true,
      index: true
    }
  };
  (0, _lodash.each)(options.includes, (type, name) => {
    def[name] = (0, _lodash.omit)(type, 'from');
  });
  const PatchSchema = new _mongoose.Schema(def);
  return options.mongoose.model(options.transforms[0](`${options.name}`), PatchSchema, options.transforms[1](`${options.name}`));
};
const defaultOptions = {
  includes: {},
  excludes: [],
  removePatches: true,
  transforms: [_humps.pascalize, _humps.decamelize],
  trackOriginalValue: false
};
const ARRAY_INDEX_WILDCARD = '*';

/**
 * Splits a json-patch-path of form `/path/to/object` to an array `['path', 'to', 'object']`.
 * Note: `/` is returned as `[]`
 *
 * @param {string} path Path to split
 */
const getArrayFromPath = path => path.replace(/^\//, '').split('/');

/**
 * Checks the provided `json-patch-operation` on `excludePath`.
 * This check joins the `path` and `value` property of the `operation`
 * and removes any hit.
 *
 * @param {import('fast-json-patch').Operation} patch operation to check with `excludePath`
 * @param {String[]} excludePath Path to property to remove from value of `operation`
 *
 * @return `false` if `patch.value` is `{}` or `undefined` after remove, `true` in any other case
 */
const deepRemovePath = (patch, excludePath) => {
  const operationPath = sanitizeEmptyPath(getArrayFromPath(patch.path));
  if (isPathContained(operationPath, excludePath)) {
    let value = patch.value;

    // because the paths overlap start at patchPath.length
    // e.g.: patch: { path:'/object', value:{ property: 'test' } }
    // pathToExclude: '/object/property'
    // need to start at array idx 1, because value starts at idx 0
    for (let i = operationPath.length; i < excludePath.length - 1; i++) {
      if (excludePath[i] === ARRAY_INDEX_WILDCARD && Array.isArray(value)) {
        // start over with each array element and make a fresh check
        // Note: it can happen that array elements are rendered to: {}
        //         we need to keep them to keep the order of array elements consistent
        value.forEach(elem => {
          deepRemovePath({
            path: '/',
            value: elem
          }, excludePath.slice(i + 1));
        });

        // If the patch value has turned to {} return false so this patch can be filtered out
        if (Object.keys(patch.value).length === 0) {
          return false;
        }
        return true;
      }
      value = value[excludePath[i]];
      if (typeof value === 'undefined') {
        return true;
      }
    }
    if (typeof value[excludePath[excludePath.length - 1]] === 'undefined') {
      return true;
    } else {
      delete value[excludePath[excludePath.length - 1]];
      // If the patch value has turned to {} return false so this patch can be filtered out
      if (Object.keys(patch.value).length === 0) {
        return false;
      }
    }
  }
  return true;
};

/**
 * Sanitizes a path `['']` to be used with `isPathContained()`
 * @param {String[]} path
 */
const sanitizeEmptyPath = path => path.length === 1 && path[0] === '' ? [] : path;

// Checks if 'fractionPath' is contained in fullPath
// Exp. 1: fractionPath '/path/to',              fullPath '/path/to/object'       => true
// Exp. 2: fractionPath '/arrayPath/*/property', fullPath '/arrayPath/1/property' => true
const isPathContained = (fractionPath, fullPath) => fractionPath.every((entry, idx) => entryIsIdentical(entry, fullPath[idx]) || matchesArrayWildcard(entry, fullPath[idx]));
const entryIsIdentical = (entry1, entry2) => entry1 === entry2;
const matchesArrayWildcard = (entry1, entry2) => isArrayIndexWildcard(entry1) && isIntegerGreaterEqual0(entry2);
const isArrayIndexWildcard = entry => entry === ARRAY_INDEX_WILDCARD;
const isIntegerGreaterEqual0 = entry => Number.isInteger(Number(entry)) && Number(entry) >= 0;

// used to convert bson to json - especially ObjectID references need
// to be converted to hex strings so that the jsonpatch `compare` method
// works correctly
const toJSON = obj => JSON.parse(JSON.stringify(obj));

// helper function to merge query conditions after an update has happened
// useful if a property which was initially defined in _conditions got overwritten
// with the update
const mergeQueryConditionsWithUpdate = (_conditions, _update) => {
  const update = _update ? _update.$set || _update : _update;
  const conditions = Object.assign({}, _conditions, update);

  // excluding updates other than $set
  Object.keys(conditions).forEach(key => {
    if (key.includes('$')) {
      delete conditions[key];
    }
  });
  return conditions;
};
function _default(schema, opts) {
  const options = (0, _lodash.merge)({}, defaultOptions, opts);

  // get _id type from schema
  options._idType = schema.tree._id.type;

  // transform excludes option
  options.excludes = options.excludes.map(getArrayFromPath);

  // validate parameters
  (0, _assert.default)(options.mongoose, '`mongoose` option must be defined');
  (0, _assert.default)(options.name, '`name` option must be defined');
  (0, _assert.default)(!schema.methods.data, 'conflicting instance method: `data`');
  (0, _assert.default)(options._idType, 'schema is missing an `_id` property');

  // used to compare instance data snapshots. depopulates instance,
  // removes version key and object id
  schema.methods.data = function () {
    return this.toObject({
      depopulate: true,
      versionKey: false,
      transform: (doc, ret /*, options*/) => {
        delete ret._id;
        // if timestamps option is set on schema, ignore timestamp fields
        if (schema.options.timestamps) {
          delete ret[schema.options.timestamps.createdAt || 'createdAt'];
          delete ret[schema.options.timestamps.updatedAt || 'updatedAt'];
        }
      }
    });
  };

  // roll the document back to the state of a given patch id()
  schema.methods.rollback = async function (patchId, data, save = true) {
    const patches = await this.patches.find({
      ref: this.id
    }).sort({
      date: 1
    }).exec();

    // patch doesn't exist
    if (!~(0, _lodash.map)(patches, 'id').indexOf(patchId)) {
      throw new RollbackError("patch doesn't exist");
    }

    // get all patches that should be applied
    const apply = (0, _lodash.dropRightWhile)(patches, patch => patch.id !== patchId);

    // if the patches that are going to be applied are all existing patches,
    // the rollback attempts to rollback to the latest patch
    if (patches.length === apply.length) {
      throw new RollbackError('rollback to latest patch');
    }

    // apply patches to `state`
    const state = {};
    apply.forEach(patch => {
      _fastJsonPatch.default.applyPatch(state, patch.ops, true);
    });

    // set new state
    this.set((0, _lodash.merge)(data, state));

    // in case of save, save it back to the db and resolve
    if (save) {
      return await this.save();
    } else {
      return this;
    }
  };

  // create patch model, enable static model access via `Patches` and
  // instance method access through an instances `patches` property
  const Patches = createPatchModel(options);
  schema.statics.Patches = Patches;
  schema.virtual('patches').get(() => Patches);

  // after a document is initialized or saved, fresh snapshots of the
  // documents data are created
  const snapshot = function () {
    this._original = toJSON(this.data());
  };
  schema.post('init', snapshot);
  schema.post('save', snapshot);

  // when a document is removed and `removePatches` is not set to false ,
  // all patch documents from the associated patch collection are also removed
  async function deletePatches(document) {
    const patches = await document.patches.find({
      ref: document._id
    });
    return Promise.all(patches.map(patch => patch.remove()));
  }
  schema.pre('remove', async function () {
    if (!options.removePatches) {
      return;
    }
    try {
      await deletePatches(this);
    } catch (error) {
      throw error;
    }
  });

  // when a document is saved, the json patch that reflects the changes is
  // computed. if the patch consists of one or more operations (meaning the
  // document has changed), a new patch document reflecting the changes is
  // added to the associated patch collection
  async function createPatch(document, queryOptions = {}) {
    const {
      _id: ref
    } = document;
    let ops = _fastJsonPatch.default.compare(document._original || {}, toJSON(document.data()));
    if (options.excludes.length > 0) {
      ops = ops.filter(op => {
        const pathArray = getArrayFromPath(op.path);
        return !options.excludes.some(exclude => isPathContained(exclude, pathArray)) && options.excludes.every(exclude => deepRemovePath(op, exclude));
      });
    }

    // don't save a patch when there are no changes to save
    if (!ops.length) {
      return;
    }

    // track original values if enabled
    if (options.trackOriginalValue) {
      ops.map(entry => {
        const path = (0, _lodash.tail)(entry.path.split('/')).join('.');
        entry.originalValue = (0, _lodash.get)(document.isNew ? {} : document._original, path);
      });
    }

    // assemble patch data
    const data = {
      ops,
      ref,
      date: document.updatedAt || document.createdAt
    };
    (0, _lodash.each)(options.includes, (type, name) => {
      data[name] = document[type.from || name] || queryOptions[type.from || name];
    });
    return await document.patches.create(data);
  }
  schema.pre('save', async function () {
    try {
      await createPatch(this);
    } catch (error) {
      throw error;
    }
  });
  schema.pre('findOneAndRemove', async function () {
    if (!options.removePatches) {
      return;
    }
    const session = this.getOptions().session;
    try {
      const original = await this.model.findOne(this._conditions).session(session);
      await deletePatches(original);
    } catch (error) {
      throw error;
    }
  });
  schema.pre('findOneAndUpdate', preUpdateOne);
  async function preUpdateOne() {
    const session = this.getOptions().session;
    try {
      const original = await this.model.findOne(this._conditions).session(session);
      if (original) {
        this._originalId = original._id;
        this._original = toJSON(original.data());
      }
    } catch (error) {
      throw error;
    }
  }
  schema.post('findOneAndUpdate', async function (doc) {
    try {
      await postUpdateOne.call(this, doc);
    } catch (error) {
      throw error;
    }
  });
  async function postUpdateOne(result) {
    var _result$lastErrorObje;
    // result might be a mongodb ModifyResult, null or a Document
    if ((result === null || result === void 0 ? void 0 : (_result$lastErrorObje = result.lastErrorObject) === null || _result$lastErrorObje === void 0 ? void 0 : _result$lastErrorObje.n) === 0 && (result === null || result === void 0 ? void 0 : result.upsertedCount) === 0) {
      return;
    }
    let conditions;
    if (this._originalId) {
      conditions = {
        _id: {
          $eq: this._originalId
        }
      };
    } else {
      conditions = mergeQueryConditionsWithUpdate(this._conditions, this._update);
    }
    const session = this.getOptions().session;
    try {
      const doc = await this.model.findOne(conditions).session(session);
      if (!doc) {
        return;
      }
      doc._original = this._original;
      await createPatch(doc, this.options);
    } catch (error) {
      throw error;
    }
  }
  schema.pre('updateOne', preUpdateOne);
  schema.post('updateOne', async function (doc) {
    try {
      await postUpdateOne.call(this, doc);
    } catch (error) {
      throw error;
    }
  });
  async function preUpdateMany() {
    const session = this.getOptions().session;
    try {
      const originals = await this.model.find(this._conditions).session(session);
      const originalIds = [];
      const originalData = [];
      for (const original of originals) {
        originalIds.push(original._id);
        originalData.push(toJSON(original.data()));
      }
      this._originalIds = originalIds;
      this._originals = originalData;
    } catch (error) {
      throw error;
    }
  }
  async function postUpdateMany(result) {
    var _result$lastErrorObje2;
    // result might be a mongodb ModifyResult, null or a Document
    if ((result === null || result === void 0 ? void 0 : (_result$lastErrorObje2 = result.lastErrorObject) === null || _result$lastErrorObje2 === void 0 ? void 0 : _result$lastErrorObje2.n) === 0 && (result === null || result === void 0 ? void 0 : result.upsertedCount) === 0) {
      return;
    }
    let conditions;
    if (this._originalIds.length === 0) {
      conditions = mergeQueryConditionsWithUpdate(this._conditions, this._update);
    } else {
      conditions = {
        _id: {
          $in: this._originalIds
        }
      };
    }
    const session = this.getOptions().session;
    try {
      const docs = await this.model.find(conditions).session(session);
      await Promise.all(docs.map((doc, i) => {
        doc._original = this._originals[i];
        return createPatch(doc, this.options);
      }));
    } catch (error) {
      throw error;
    }
  }
  schema.pre('updateMany', async function () {
    try {
      await preUpdateMany.call(this);
    } catch (error) {
      throw error;
    }
  });
  schema.post('updateMany', async function (result) {
    try {
      await postUpdateMany.call(this, result);
    } catch (error) {
      throw error;
    }
  });
  schema.pre('update', async function () {
    try {
      if (this.options.multi) {
        await preUpdateMany.call(this);
      } else {
        await preUpdateOne.call(this);
      }
    } catch (error) {
      throw error;
    }
  });
  schema.post('update', async function (result) {
    try {
      if (this.options.multi) {
        await postUpdateMany.call(this, result);
      } else {
        await postUpdateOne.call(this, result);
      }
    } catch (error) {
      throw error;
    }
  });
}