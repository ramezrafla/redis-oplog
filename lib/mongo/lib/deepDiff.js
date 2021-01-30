/*!
 * deep-diff.
 * Licensed under the MIT License.
 */

// https://github.com/flitbit/diff -- using index.js from Bower version 0.3.3
// made changes to force return of function to DeepDiff global variable

/*
ZeGenie Changes:
- removed hackish setting of accumulateDiff at the end
- removed platform check at the beginning
- removed $conflict everywhere
- added standard ES6 export
- code cleanup and eslint-disable-next-line additions
*/

const DeepDiff = function() {

  // nodejs compatible on server side and in the browser.
  function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    })
  }

  function Diff(kind, path) {
    Object.defineProperty(this, 'kind', {
      value: kind,
      enumerable: true
    })
    if (path && path.length) {
      Object.defineProperty(this, 'path', {
        value: path,
        enumerable: true
      })
    }
  }

  function DiffEdit(path, origin, value) {
    DiffEdit.super_.call(this, 'E', path)
    Object.defineProperty(this, 'lhs', {
      value: origin,
      enumerable: true
    })
    Object.defineProperty(this, 'rhs', {
      value: value,
      enumerable: true
    })
  }
  inherits(DiffEdit, Diff)

  function DiffNew(path, value) {
    DiffNew.super_.call(this, 'N', path)
    Object.defineProperty(this, 'rhs', {
      value: value,
      enumerable: true
    })
  }
  inherits(DiffNew, Diff)

  function DiffDeleted(path, value) {
    DiffDeleted.super_.call(this, 'D', path)
    Object.defineProperty(this, 'lhs', {
      value: value,
      enumerable: true
    })
  }
  inherits(DiffDeleted, Diff)

  function DiffArray(path, index, item) {
    DiffArray.super_.call(this, 'A', path)
    Object.defineProperty(this, 'index', {
      value: index,
      enumerable: true
    })
    Object.defineProperty(this, 'item', {
      value: item,
      enumerable: true
    })
  }
  inherits(DiffArray, Diff)

  function realTypeOf(subject) {
    var type = typeof subject
    if (type !== 'object') return type
    if (subject === Math) return 'math'
    if (subject === null) return 'null'
    if (Array.isArray(subject)) return 'array'
    if (Object.prototype.toString.call(subject) === '[object Date]') return 'date'
    if (typeof subject.toString === 'function' && /^\/.*\//.test(subject.toString())) return 'regexp'
    return 'object'
  }

  // http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
  function hashThisString(string) {
    var hash = 0
    if (string.length === 0) { return hash }
    for (var i = 0; i < string.length; i++) {
      var char = string.charCodeAt(i)
      // eslint-disable-next-line no-bitwise
      hash = ((hash << 5) - hash) + char
      // eslint-disable-next-line
      hash = hash & hash // Convert to 32bit integer
    }
    return hash
  }

  // Gets a hash of the given object in an array order-independent fashion
  // also object key order independent (easier since they can be alphabetized)
  function getOrderIndependentHash(object) {
    var accum = 0
    var type = realTypeOf(object)

    if (type === 'array') {
      object.forEach(function (item) {
        // Addition is commutative so this is order indep
        accum += getOrderIndependentHash(item)
      })
      var arrayString = '[type: array, hash: ' + accum + ']'
      return accum + hashThisString(arrayString)
    }

    if (type === 'object') {
      // eslint-disable-next-line no-restricted-syntax
      for (var key in object) {
        // eslint-disable-next-line no-prototype-builtins
        if (object.hasOwnProperty(key)) {
          var keyValueString = '[ type: object, key: ' + key + ', value hash: ' + getOrderIndependentHash(object[key]) + ']'
          accum += hashThisString(keyValueString)
        }
      }
      return accum
    }

    // Non object, non array...should be good?
    var stringToHash = '[ type: ' + type + '  value: ' + object + ']'
    return accum + hashThisString(stringToHash)
  }

  function deepDiff(lhs, rhs, changes, prefilter, path, key, stack, orderIndependent) {
    changes = changes || []
    path = path || []
    stack = stack || []
    var currentPath = path.slice(0)
    if (typeof key !== 'undefined' && key != null) {
      if (prefilter) {
        if (typeof (prefilter) === 'function' && prefilter(currentPath, key)) return
        else if (typeof (prefilter) === 'object') {
          if (prefilter.prefilter && prefilter.prefilter(currentPath, key)) return
          if (prefilter.normalize) {
            var alt = prefilter.normalize(currentPath, key, lhs, rhs)
            if (alt) {
              lhs = alt[0]
              rhs = alt[1]
            }
          }
        }
      }
      currentPath.push(key)
    }

    // Use string comparison for regexes
    if (realTypeOf(lhs) === 'regexp' && realTypeOf(rhs) === 'regexp') {
      lhs = lhs.toString()
      rhs = rhs.toString()
    }

    var ltype = lhs == null ? 'undefined' : typeof lhs
    var rtype = rhs == null ? 'undefined' : typeof rhs
    var i, j, k, other

    var ldefined = ltype !== 'undefined'
    var rdefined = rtype !== 'undefined'

    if (!ldefined && rdefined) {
      changes.push(new DiffNew(currentPath, rhs))
    }
    else if (!rdefined && ldefined) {
      changes.push(new DiffDeleted(currentPath, lhs))
    }
    else if (realTypeOf(lhs) !== realTypeOf(rhs)) {
      changes.push(new DiffEdit(currentPath, lhs, rhs))
    }
    else if (realTypeOf(lhs) === 'date' && (lhs - rhs) !== 0) {
      changes.push(new DiffEdit(currentPath, lhs, rhs))
    }
    else if (ltype === 'object' && lhs !== null && rhs !== null) {
      for (i = stack.length - 1; i > -1; --i) {
        if (stack[i].lhs === lhs) {
          other = true
          break
        }
      }
      if (!other) {
        stack.push({ lhs: lhs, rhs: rhs })
        if (Array.isArray(lhs)) {
          // If order doesn't matter, we need to sort our arrays
          if (orderIndependent) {
            lhs.sort(function (a, b) {
              return getOrderIndependentHash(a) - getOrderIndependentHash(b)
            })
            rhs.sort(function (a, b) {
              return getOrderIndependentHash(a) - getOrderIndependentHash(b)
            })
          }
          i = rhs.length - 1
          j = lhs.length - 1
          while (i > j) {
            changes.push(new DiffArray(currentPath, i, new DiffNew(undefined, rhs[i--])))
          }
          while (j > i) {
            changes.push(new DiffArray(currentPath, j, new DiffDeleted(undefined, lhs[j--])))
          }
          for (; i >= 0; --i) {
            deepDiff(lhs[i], rhs[i], changes, prefilter, currentPath, i, stack, orderIndependent)
          }
        }
        else {
          var akeys = Object.keys(lhs).concat(Object.getOwnPropertySymbols(lhs))
          var pkeys = Object.keys(rhs).concat(Object.getOwnPropertySymbols(rhs))
          for (i = 0; i < akeys.length; ++i) {
            k = akeys[i]
            other = pkeys.indexOf(k)
            if (other >= 0) {
              deepDiff(lhs[k], rhs[k], changes, prefilter, currentPath, k, stack, orderIndependent)
              pkeys[other] = null
            }
            else {
              deepDiff(lhs[k], undefined, changes, prefilter, currentPath, k, stack, orderIndependent)
            }
          }
          for (i = 0; i < pkeys.length; ++i) {
            k = pkeys[i]
            if (k) deepDiff(undefined, rhs[k], changes, prefilter, currentPath, k, stack, orderIndependent)
          }
        }
        // eslint-disable-next-line operator-assignment
        stack.length = stack.length - 1
      }
      else if (lhs !== rhs) {
        // lhs is contains a cycle at this element and it differs from rhs
        changes.push(new DiffEdit(currentPath, lhs, rhs))
      }
    }
    else if (lhs !== rhs) {
      if (!(ltype === 'number' && isNaN(lhs) && isNaN(rhs))) changes.push(new DiffEdit(currentPath, lhs, rhs))
    }
  }

  function diff(lhs, rhs, getFields) {
    var changes = []
    deepDiff(lhs, rhs, changes)
    if (changes.length == 0) return false
    console.log(changes)
    if (getFields) {
      const updated = []
      const cleared = []
      changes.forEach((c) => {
        if (c.kind == 'D') cleared.push(c.path && c.path[0])
        else updated.push(c.path && c.path[0])
      })
      return [updated, cleared]
    }
    return true
  }

  return diff
}()

export default DeepDiff
