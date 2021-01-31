/*!
 * deep-diff.
 * Licensed under the MIT License.
 */

// https://github.com/flitbit/diff -- using index.js from Bower version 0.3.3
// made changes to force return of function to DeepDiff global variable

/*
ZeGenie Changes:
- removed hackish setting at the end
- removed platform check at the beginning
- removed $conflict everywhere
- added standard ES6 export
- code cleanup and eslint-disable-next-line additions
- removed extra methods we don't need -- mutation and reverting of changing
- made ldefined & rdefined stricter (we don't check the stack of the other side) to quickly catch deleted fields
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
    if (type == 'undefined' || subject == null) return 'null'
    if (type !== 'object') return type
    if (Array.isArray(subject)) return 'array'
    if (subject instanceof Date) return 'date'
    if (subject instanceof RegExp) return 'regexp'
    return 'object'
  }

  function deepDiff(lhs, rhs, changes, path, key, stack) {
    changes = changes || []
    path = path || []
    stack = stack || []
    var currentPath = path.slice(0)
    if (typeof key !== 'undefined' && key != null) {
      currentPath.push(key)
    }

    var ltype = realTypeOf(lhs)
    var rtype = realTypeOf(rhs)

    // Use string comparison for regexes
    if (ltype === 'regexp' && rtype === 'regexp') {
      lhs = lhs.toString()
      rhs = rhs.toString()
    }

    var ldefined = ltype != 'null'
    var rdefined = rtype != 'null'
    var i, j, k, other

    if (!ldefined && rdefined) {
      changes.push(new DiffNew(currentPath, rhs))
    }
    else if (!rdefined && ldefined) {
      changes.push(new DiffDeleted(currentPath, lhs))
    }
    else if (ltype !== rtype) {
      changes.push(new DiffEdit(currentPath, lhs, rhs))
    }
    else if (ltype == 'date') {
      if (lhs.getTime() != rhs.getTime()) changes.push(new DiffEdit(currentPath, lhs, rhs))
    }
    else if (ltype === 'object' || ltype == 'array') {
      for (i = stack.length - 1; i > -1; --i) {
        if (stack[i].lhs === lhs) {
          other = true
          break
        }
      }
      if (!other) {
        stack.push({ lhs, rhs })
        if (ltype == 'array') {
          i = rhs.length - 1
          j = lhs.length - 1
          while (i > j) {
            changes.push(new DiffArray(currentPath, i, new DiffNew(undefined, rhs[i--])))
          }
          while (j > i) {
            changes.push(new DiffArray(currentPath, j, new DiffDeleted(undefined, lhs[j--])))
          }
          for (; i >= 0; --i) {
            deepDiff(lhs[i], rhs[i], changes, currentPath, i, stack)
          }
        }
        else {
          var akeys = Object.keys(lhs).concat(Object.getOwnPropertySymbols(lhs))
          var pkeys = Object.keys(rhs).concat(Object.getOwnPropertySymbols(rhs))
          for (i = 0; i < akeys.length; ++i) {
            k = akeys[i]
            other = pkeys.indexOf(k)
            if (other >= 0) {
              deepDiff(lhs[k], rhs[k], changes, currentPath, k, stack)
              pkeys[other] = null
            }
            else {
              deepDiff(lhs[k], undefined, changes, currentPath, k, stack)
            }
          }
          for (i = 0; i < pkeys.length; ++i) {
            k = pkeys[i]
            if (k) deepDiff(undefined, rhs[k], changes, currentPath, k, stack)
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
    else if (lhs != rhs) {
      changes.push(new DiffEdit(currentPath, lhs, rhs))
    }
  }

  function diff(lhs, rhs, getFields) {
    const changes = []
    deepDiff(lhs, rhs, changes)
    if (changes.length == 0) return false
    // console.log(changes)
    if (getFields) {
      const updated = []
      const cleared = []
      changes.forEach((c) => {
        if (c.kind == 'D') cleared.push(c.path[0])
        else updated.push(c.path[0])
      })
      return [updated, cleared]
    }
    return true
  }

  return diff
}()

export default DeepDiff
