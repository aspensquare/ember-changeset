import Ember from 'ember';
import objectToArray from 'ember-changeset/utils/computed/object-to-array';
import isEmptyObject from 'ember-changeset/utils/computed/is-empty-object';
// import objectEqual from 'ember-changeset/utils/computed/object-equal';
import pathObjectEqual from 'ember-changeset/utils/computed/path-object-equal';
import isPromise from 'ember-changeset/utils/is-promise';
import isObject from 'ember-changeset/utils/is-object';
import pureAssign from 'ember-changeset/utils/assign';
import objectWithout from 'ember-changeset/utils/object-without';
import includes from 'ember-changeset/utils/includes';
import take from 'ember-changeset/utils/take';
import isChangeset, { CHANGESET } from 'ember-changeset/utils/is-changeset';

const {
  Object: EmberObject,
  RSVP: { all, resolve },
  computed: { not, readOnly },
  A: emberArray,
  assert,
  get,
  isArray,
  isEqual,
  isNone,
  isPresent,
  set,
  setProperties,
  typeOf
} = Ember;
const { keys } = Object;
const CONTENT = '_content';
const CHANGES = '_changes';
const ERRORS = '_errors';
const VALIDATOR = '_validator';
const OPTIONS = '_options';

function defaultValidatorFn() {
  return true;
}

const defaultOptions = { skipValidate: false };

/**
 * Creates new changesets.
 *
 * @param  {Object} obj
 * @param  {Function} validateFn
 * @param  {Object} validationMap
 * @param  {Object}  options
 * @return {Ember.Object}
 */
export function changeset(obj, validateFn = defaultValidatorFn, validationMap = {}, options = {}) {
  assert('Underlying object for changeset is missing', isPresent(obj));

  return EmberObject.extend({
    /**
     * Internal descriptor for changeset identification
     *
     * @private
     * @property __changeset__
     * @type {String}
     */
    __changeset__: CHANGESET,

    changes: objectToArray(CHANGES, false),
    errors: objectToArray(ERRORS, true),
    change: readOnly(CHANGES),
    error: readOnly(ERRORS),

    isValid: isEmptyObject(ERRORS),
    isPristine: pathObjectEqual(CHANGES, CONTENT),
    isPristine: isEmptyObject(CHANGES),
    isInvalid: not('isValid').readOnly(),
    isDirty: not('isPristine').readOnly(),

    init() {
      this._super(...arguments);
      this[CONTENT] = obj;
      this[CHANGES] = {};
      this[ERRORS] = {};
      this[VALIDATOR] = validateFn;
      this[OPTIONS] = pureAssign(defaultOptions, options);
    },

    /**
     * Proxies `get` to the underlying content or changed value, if present.
     *
     * @public
     * @param  {String} key
     * @return {Any}
     */
    unknownProperty(key) {
      return this._valueFor(key);
    },

    /**
     * Stores change on the changeset.
     *
     * @public
     * @param  {String} key
     * @param  {Any} value
     * @return {Any}
     */
    setUnknownProperty(key, value) {
      let changesetOptions = get(this, OPTIONS);
      let skipValidate = get(changesetOptions, 'skipValidate');
      if (skipValidate) {
        return this._setProperty(true, { key, value });
      }
      return this._validateAndSet(key, value);
    },

    /**
     * String representation for the changeset.
     *
     * @public
     * @return {String}
     */
    toString() {
      return `changeset:${get(this, CONTENT).toString()}`;
    },

    /**
     * Provides a function to run before emitting changes to the model. The
     * callback function must return a hash in the same shape:
     *
     * ```
     * changeset
     *   .prepare((changes) => {
     *     let modified = {};
     *
     *     for (let key in changes) {
     *       modified[underscore(key)] = changes[key];
     *     }
     *
     *    return modified; // { first_name: "Jim", last_name: "Bob" }
     *  })
     *  .execute(); // execute the changes
     * ```
     *
     * @public
     * @chainable
     * @param  {Function} prepareChangesFn
     * @return {Changeset}
     */
    prepare(prepareChangesFn) {
      let changes = pureAssign(get(this, CHANGES));
      let preparedChanges = prepareChangesFn(changes);

      assert('Callback to `changeset.prepare` must return an object', isObject(preparedChanges));

      set(this, CHANGES, preparedChanges);

      return this;
    },

    /**
     * Executes the changeset if in a valid state.
     *
     * @public
     * @chainable
     * @return {Changeset}
     */
    execute() {
      if (get(this, 'isValid') && get(this, 'isDirty')) {
        let content = get(this, CONTENT);
        let changes = get(this, CHANGES);
        setProperties(content, changes);
      }

      return this;
    },

    /**
     * Executes the changeset and saves the underlying content.
     *
     * @async
     * @public
     * @param  {Object} options optional object to pass to content save method
     * @return {Promise}
     */
    save(options) {
      let content = get(this, CONTENT);
      let savePromise = resolve(this);

      this.execute();

      if (typeOf(content.save) === 'function') {
        savePromise = content.save(options);
      }

      return savePromise.then((result) => {
        this.rollback();
        return result;
      });
    },

    /**
     * Returns the changeset to its pristine state, and discards changes and
     * errors.
     *
     * @public
     * @chainable
     * @return {Changeset}
     */
    rollback() {
      this._notifyVirtualProperties();
      set(this, CHANGES, {});
      set(this, ERRORS, {});

      return this;
    },

    /**
     * Merges 2 valid changesets and returns a new changeset. Both changesets
     * must point to the same underlying object. The changeset target is the
     * origin. For example:
     *
     * ```
     * let changesetA = new Changeset(user, validatorFn);
     * let changesetB = new Changeset(user, validatorFn);
     * changesetA.set('firstName', 'Jim');
     * changesetB.set('firstName', 'Jimmy');
     * changesetB.set('lastName', 'Fallon');
     * let changesetC = changesetA.merge(changesetB);
     * changesetC.execute();
     * user.get('firstName'); // "Jimmy"
     * user.get('lastName'); // "Fallon"
     * ```
     *
     * @public
     * @chainable
     * @param  {Changeset} changeset
     * @return {Changeset}
     */
    merge(changeset) {
      let content = get(this, CONTENT);
      assert('Cannot merge with a non-changeset', isChangeset(changeset));
      assert('Cannot merge with a changeset of different content', get(changeset, CONTENT) === content);

      if (get(this, 'isPristine') && get(changeset, 'isPristine')) {
        return this;
      }

      let changesA = get(this, CHANGES);
      let changesB = get(changeset, CHANGES);
      let errorsA = get(this, ERRORS);
      let errorsB = get(changeset, ERRORS);
      let newChangeset = new Changeset(content, get(this, VALIDATOR));
      let newErrors = objectWithout(keys(changesB), errorsA);
      let newChanges = objectWithout(keys(errorsB), changesA);
      let mergedChanges = pureAssign(newChanges, changesB);
      let mergedErrors = pureAssign(newErrors, errorsB);

      newChangeset[CHANGES] = mergedChanges;
      newChangeset[ERRORS] = mergedErrors;
      newChangeset._notifyVirtualProperties();

      return newChangeset;
    },

    /**
     * Validates the changeset immediately against the validationMap passed in.
     * If no key is passed into this method, it will validate all fields on the
     * validationMap and set errors accordingly. Will throw an error if no
     * validationMap is present.
     *
     * @async
     * @public
     * @param  {String|Undefined} key
     * @return {Promise}
     */
    validate(key) {
      if (keys(validationMap).length === 0) {
        return resolve(null);
      }

      if (isNone(key)) {
        let maybePromise = keys(validationMap)
          .map((validationKey) => {
            return this._validateAndSet(validationKey, this._valueFor(validationKey));
          });

        return all(maybePromise);
      }

      return resolve(this._validateAndSet(key, this._valueFor(key)));
    },

    /**
     * Manually add an error to the changeset. If there is an existing error or
     * change for `key`, it will be overwritten.
     *
     * @public
     * @param {String} key
     * @param {Any} options.value
     * @param {Any} options.validation Validation message
     * @return {Any}
     */
    addError(key, options) {
      let errors = get(this, ERRORS);

      if (!isObject(options)) {
        let value = get(this, key);
        options = { value, validation: options };
      }

      this._deleteKey(CHANGES, key);
      this.notifyPropertyChange(ERRORS);
      // this.notifyPropertyChange(key);
      this.notifyPropertyChange(key.split('.')[0]);

      // return set(errors, key, options);
      return errors[key] = options;
    },

    /**
     * Manually push multiple errors to the changeset as an array. If there is
     * an existing error or change for `key`. it will be overwritten.
     *
     * @param  {String} key
     * @param  {...[String]} newErrors
     * @return {Any}
     */
    pushErrors(key, ...newErrors) {
      let errors = get(this, ERRORS);
      // let existingError = get(errors, key) || { validation: [] };
      let existingError = errors[key] || { validation: [] };
      let { validation } = existingError;
      let value = get(this, key);

      if (!isArray(validation) && isPresent(validation)) {
        existingError.validation = [existingError.validation];
      }

      validation = [...existingError.validation, ...newErrors];

      this._deleteKey(CHANGES, key);
      this.notifyPropertyChange(ERRORS);
      // this.notifyPropertyChange(key);
      this.notifyPropertyChange(key.split('.')[0]);

      // return set(errors, key, { value, validation });
      return errors[key] = { value, validation };
    },

    /**
     * Creates a snapshot of the changeset's errors and changes.
     *
     * @public
     * @return {Object} snapshot
     */
    snapshot() {
      return {
        changes: pureAssign(get(this, CHANGES)),
        errors: pureAssign(get(this, ERRORS))
      };
    },

    /**
     * Restores a snapshot of changes and errors. This overrides existing
     * changes and errors.
     *
     * @public
     * @chainable
     * @param  {Object} options.changes
     * @param  {Object} options.errors
     * @return {Changeset}
     */
    restore({ changes, errors }) {
      set(this, CHANGES, changes);
      set(this, ERRORS, errors);
      this._notifyVirtualProperties();

      return this;
    },

    /**
     * Unlike `Ecto.Changeset.cast`, `cast` will take allowed keys and
     * remove unwanted keys off of the changeset. For example, this method
     * can be used to only allow specified changes through prior to saving.
     *
     * @public
     * @chainable
     * @param  {Array} allowed Array of allowed keys
     * @return {Changeset}
     */
    cast(allowed = []) {
      let changes = get(this, CHANGES);

      if (isArray(allowed) && allowed.length === 0) {
        return changes;
      }

      let changeKeys = keys(changes);
      let validKeys = emberArray(changeKeys).filter((key) => includes(allowed, key));
      let casted = take(changes, validKeys);

      set(this, CHANGES, casted);

      return this;
    },

    /**
     * For a given key and value, set error or change.
     *
     * @private
     * @param  {String} key
     * @param  {Any} value
     * @return {Any}
     */
    _validateAndSet(key, value) {
      let content = get(this, CONTENT);
      let oldValue = get(content, key);
      let validation = this._validate(key, value, oldValue);

      if (isPromise(validation)) {
        return validation.then((resolvedValidation) => {
          return this._setProperty(resolvedValidation, { key, value, oldValue });
        });
      }

      return this._setProperty(validation, { key, value, oldValue });
    },

    /**
     * Validates a given key and value.
     *
     * @private
     * @param {String} key
     * @param {Any} newValue
     * @param {Any} oldValue
     * @return {Boolean|String}
     */
    _validate(key, newValue, oldValue) {
      let changes = get(this, CHANGES);
      let validator = get(this, VALIDATOR);
      let content = get(this, CONTENT);

      if (typeOf(validator) === 'function') {
        let isValid = validator({
          key,
          newValue,
          oldValue,
          changes: pureAssign(changes),
          content,
        });

        return isPresent(isValid) ? isValid : true;
      }

      return true;
    },

    /**
     * Sets property or error on the changeset.
     *
     * @private
     * @param {Boolean|Array|String} validation
     * @param {String} options.key
     * @param {Any} options.value
     * @return {Any}
     */
    _setProperty(validation, { key, value, oldValue } = {}) {
      let changes = get(this, CHANGES);
      let isSingleValidationArray =
        isArray(validation) &&
        validation.length === 1 &&
        validation[0] === true;

      if (validation === true || isSingleValidationArray) {
        this._deleteKey(ERRORS, key);

        if (!isEqual(oldValue, value)) {
          // set(changes, key, value);
          changes[key] = value;
        } else if (key in obj) {
          delete changes[key];
        }
        this.notifyPropertyChange(CHANGES);
        // this.notifyPropertyChange(key);
        this.notifyPropertyChange(key.split('.')[0]);

        let errors = get(this, ERRORS);
        if (errors['__ember_meta__'] && errors['__ember_meta__']['values']) {
          delete errors['__ember_meta__']['values'][key];
          set(this, ERRORS, errors);
        }

        return value;
      }

      return this.addError(key, { value, validation });
    },

    /**
     * Value for change or the original value.
     *
     * @private
     * @param  {String} key
     * @return {Any}
     */
    _valueFor(key) {
      let changes = get(this, CHANGES);
      let errors = get(this, ERRORS);
      let content = get(this, CONTENT);

      if (errors.hasOwnProperty(key)) {
        // return get(errors, `${key}.value`);
        return errors[key].value;
      }

      if (changes.hasOwnProperty(key)) {
        return changes[key];
      }

      const value = get(content, key);
      const valueType = typeOf(value);

      const self = this;

      if (valueType === 'object'|| valueType === 'instance') {
        // using closures so that no properties are defined on the proxy classes
        const ChangesetObjectProxy = Ember.Object.extend({
          unknownProperty(nextKey) {
            return self.unknownProperty(key + '.' + nextKey);
          },
          setUnknownProperty(nextKey, value) {
            return self.setUnknownProperty(key + '.' + nextKey, value);
          }
        });
        return ChangesetObjectProxy.create();
      }
      if (valueType === 'array') {
        // arrays containing primitives not supported
        // might be able to use a proxy for them
        // https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Proxy
        // https://github.com/GoogleChrome/proxy-polyfill
        return Ember.ArrayProxy.create({
          content: Ember.A(value),
          objectAtContent: function(idx) {
            const ChangesetArrayElementProxy = Ember.Object.extend({
              unknownProperty(nextKey) {
                return self.unknownProperty(key + '.' + idx + '.' + nextKey);
              },
              setUnknownProperty(nextKey, value) {
                return self.setUnknownProperty(key + '.' + idx + '.' + nextKey, value);
              }
            });
            return ChangesetArrayElementProxy.create();
          }
        });
      }
      return value;
    },

    /**
     * Notifies all virtual properties set on the changeset of a change.
     *
     * @private
     * @return {Void}
     */
    _notifyVirtualProperties() {
      // let rollbackKeys = [...keys(get(this, CHANGES)), ...keys(get(this, ERRORS))];
      let rollbackKeys = [...(keys(get(this, CHANGES)).map(k => k.split('.')[0])), ...keys(get(this, ERRORS))];

      for (let i = 0; i < rollbackKeys.length; i++) {
        this.notifyPropertyChange(rollbackKeys[i]);
      }
    },

    /**
     * Deletes a key off an object and notifies observers.
     *
     * @private
     * @param  {String} objName
     * @param  {String} key
     * @return {Void}
     */
    _deleteKey(objName, key) {
      let obj = get(this, objName);

      if (isNone(obj)) {
        return;
      }

      if (obj.hasOwnProperty(key)) {
        delete obj[key];
        this.notifyPropertyChange(`${objName}.${key}`);
        this.notifyPropertyChange(objName);
      }
    }
  });
}

export default class Changeset {
  /**
   * Changeset factory
   *
   * @class Changeset
   * @constructor
   */
  constructor() {
    return changeset(...arguments).create();
  }
}
