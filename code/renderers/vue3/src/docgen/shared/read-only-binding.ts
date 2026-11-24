import {
  type Binding,
  type ESTreeNode as Node,
  type ReferenceContext,
  isTSWrapper,
  textOf,
  unwrapExpression,
} from 'storybook/internal/csf-tools';

import { isFunctionExpression } from './classify-value.ts';

/**
 * What a module-level binding holds, for the bindings whose value cannot have changed by the time
 * a story renders:
 *
 * - `primitive`: a string, number, boolean, `null` or `undefined`, which nothing changes
 * - `function`: a function, which is called rather than changed
 * - `flat`: an array or object literal of primitives, which the story file only ever reads
 */
export type UnchangingKind = 'primitive' | 'function' | 'flat';

// Array methods that leave the array as it is. On an array of primitives neither their callbacks
// nor their results can reach back into it.
const ARRAY_READING_METHODS = new Set(
  (
    'at concat entries every filter find findIndex findLast findLastIndex flat flatMap forEach ' +
    'includes indexOf join keys lastIndexOf map reduce reduceRight slice some toReversed ' +
    'toSorted toSpliced toString values with'
  ).split(' ')
);

// Array methods whose result is a primitive when the array holds primitives.
const ARRAY_PRIMITIVE_METHODS = new Set('at includes indexOf join lastIndexOf'.split(' '));

// String and number methods whose result is a primitive.
const PRIMITIVE_METHODS = new Set(
  (
    'at charAt charCodeAt codePointAt concat endsWith includes indexOf lastIndexOf ' +
    'localeCompare normalize padEnd padStart repeat replace replaceAll search slice startsWith ' +
    'substring toFixed toLocaleString toLowerCase toPrecision toString toUpperCase trim trimEnd ' +
    'trimStart valueOf'
  ).split(' ')
);

// Functions that read their arguments and leave them as they are.
const READING_FUNCTIONS = new Set(
  (
    'Array.from Array.isArray Boolean JSON.stringify Number Object.entries Object.keys ' +
    'Object.values String console.debug console.error console.info console.log console.warn ' +
    'expect structuredClone'
  ).split(' ')
);

// Constructors that copy what they are given.
const COPYING_CONSTRUCTORS = new Set(['Map', 'Set']);

// The calls a CSF factory story file hands its meta and story configs to.
const FACTORY_METHODS = new Set(['extend', 'meta', 'story']);

const PRIMITIVE_GLOBALS = new Set(['Infinity', 'NaN', 'undefined']);

const isWrapper = (node: Node): boolean =>
  node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression' || isTSWrapper(node);

// `typeof lines` in a type, which reads nothing when the module runs.
const isTypePosition = (parent: Node): boolean =>
  parent.type.startsWith('TS') && !isTSWrapper(parent);

interface Analysis {
  ctx: ReferenceContext;
  kinds: Map<Binding, UnchangingKind | undefined>;
  /** Bindings whose kind or use is being decided, which a cycle through them takes as settled. */
  visiting: Set<Binding>;
}

/**
 * The kind of value a module-level binding holds, when that value is certain to be the one it is
 * declared with once a story renders. `undefined` when it is not certain.
 *
 * Whether an arbitrary object is left alone cannot be read off a file: `items.find(...)` hands out
 * the object a later line changes, and so does a callback, a getter or an alias. So only values
 * that have nothing to hand out qualify, and of those an array or object of primitives has to be
 * read wherever the file names it. A snippet that leaves an arg out says it did, while one that
 * declares a stale value shows a story that does not exist.
 *
 * @example
 * `const lines = ['a', 'b']` → 'flat', and `undefined` once the file has `lines.push('c')`;
 * `const items = [{ id: 1 }]` → `undefined`
 */
export function unchangingKind(
  binding: Binding,
  ctx: ReferenceContext
): UnchangingKind | undefined {
  return kindOfBinding(binding, { ctx, kinds: new Map(), visiting: new Set() });
}

function kindOfBinding(binding: Binding, analysis: Analysis): UnchangingKind | undefined {
  if (analysis.kinds.has(binding)) {
    return analysis.kinds.get(binding);
  }
  // A `var` is `undefined` to the code above it, which no declaration in the snippet reproduces.
  if (
    !binding.constant ||
    binding.kind === 'var' ||
    binding.node.type !== 'VariableDeclarator' ||
    binding.node.id.type !== 'Identifier' ||
    !binding.node.init ||
    analysis.visiting.has(binding)
  ) {
    return undefined;
  }

  analysis.visiting.add(binding);
  let kind = kindOfValue(unwrapExpression(binding.node.init), analysis);
  if (kind === 'flat' && !binding.references.every((reference) => readsFlat(reference, analysis))) {
    kind = undefined;
  }
  analysis.visiting.delete(binding);
  analysis.kinds.set(binding, kind);
  return kind;
}

function kindOfValue(node: Node, analysis: Analysis): UnchangingKind | undefined {
  const value = unwrapExpression(node);
  const kindOf = (child: Node) => kindOfValue(child, analysis);
  const isPrimitive = (child: Node) => kindOf(child) === 'primitive';
  // What a member is read off or a method is called on, which names an array without handing it on.
  const kindOfHolder = (child: Node) => {
    const holder = unwrapExpression(child);
    const binding =
      holder.type === 'Identifier'
        ? analysis.ctx.editor.scopes.program.bindings.get(holder.name)
        : undefined;
    return binding ? kindOfBinding(binding, analysis) : kindOf(holder);
  };

  if (isFunctionExpression(value)) {
    return 'function';
  }

  switch (value.type) {
    case 'Literal':
      return 'regex' in value && value.regex ? undefined : 'primitive';

    // Whatever their operands hold, these make a primitive.
    case 'TemplateLiteral':
    case 'BinaryExpression':
      return 'primitive';

    case 'UnaryExpression':
      return value.operator === 'delete' ? undefined : 'primitive';

    case 'Identifier': {
      const binding = analysis.ctx.editor.scopes.program.bindings.get(value.name);
      if (!binding) {
        return PRIMITIVE_GLOBALS.has(value.name) ? 'primitive' : undefined;
      }
      // Another name for an array is a second way to change it.
      const kind = kindOfBinding(binding, analysis);
      return kind === 'flat' ? undefined : kind;
    }

    case 'MemberExpression': {
      const holder = kindOfHolder(value.object);
      return holder === 'flat' || holder === 'primitive' ? 'primitive' : undefined;
    }

    case 'CallExpression': {
      const callee = unwrapExpression(value.callee);
      if (
        callee.type !== 'MemberExpression' ||
        callee.computed ||
        callee.property.type !== 'Identifier'
      ) {
        return undefined;
      }
      const receiver = kindOfHolder(callee.object);
      const methods =
        receiver === 'flat'
          ? ARRAY_PRIMITIVE_METHODS
          : receiver === 'primitive'
            ? PRIMITIVE_METHODS
            : undefined;
      return methods?.has(callee.property.name) ? 'primitive' : undefined;
    }

    case 'ArrayExpression':
      return value.elements.every(
        (element) => element !== null && element.type !== 'SpreadElement' && isPrimitive(element)
      )
        ? 'flat'
        : undefined;

    case 'ObjectExpression':
      return value.properties.every(
        (property) =>
          property.type === 'Property' &&
          property.kind === 'init' &&
          !property.method &&
          !property.computed &&
          isPrimitive(property.value)
      )
        ? 'flat'
        : undefined;

    default:
      return undefined;
  }
}

// `lines` in `lines.items[0]`: the member read it starts, and how many members deep that goes.
function memberRead(reference: Node, { editor }: ReferenceContext) {
  let read = reference;
  let depth = 0;
  let parent = editor.parentOf(read);
  while (parent) {
    if (parent.type === 'MemberExpression' && parent.object === read) {
      depth += 1;
    } else if (!isWrapper(parent)) {
      break;
    }
    read = parent;
    parent = editor.parentOf(read);
  }
  return { read, depth, parent };
}

// `lines[0] = 'z'`, `[lines[0]] = ['z']`, `for (lines[0] of other)`, `lines.length += 1`.
function isWritten(read: Node, parent: Node, { editor }: ReferenceContext): boolean {
  switch (parent.type) {
    case 'AssignmentExpression':
    case 'AssignmentPattern':
    case 'ForInStatement':
    case 'ForOfStatement':
      return parent.left === read;
    case 'UpdateExpression':
    case 'ArrayPattern':
    case 'RestElement':
      return true;
    case 'UnaryExpression':
      return parent.operator === 'delete';
    case 'Property':
      return editor.parentOf(parent)?.type === 'ObjectPattern';
    default:
      return false;
  }
}

// The statements that export a binding count among its references.
const isExport = (node: Node): boolean => node.type.startsWith('Export');

// Whether one reference to an array or object of primitives reads it. A member read off it is a
// primitive, so only what is done with the whole value, and a write, can change it.
function readsFlat(reference: Node, analysis: Analysis): boolean {
  if (reference.type !== 'Identifier') {
    return isExport(reference);
  }
  const { ctx } = analysis;
  const { read, depth, parent } = memberRead(reference, ctx);
  if (!parent) {
    return false;
  }
  if (isTypePosition(parent) || isExport(parent)) {
    return true;
  }
  if (isWritten(read, parent, ctx)) {
    return false;
  }

  if (parent.type === 'CallExpression' && parent.callee === read) {
    // `lines[0].trim()` calls a primitive's method; `lines.join()` has to be a method that reads.
    const callee = unwrapExpression(read);
    return (
      depth > 1 ||
      (depth === 1 &&
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        ARRAY_READING_METHODS.has(callee.property.name))
    );
  }

  return depth > 0 || readsWhole(read, analysis);
}

// Whether the place the whole array or object is written in only reads it.
function readsWhole(value: Node, analysis: Analysis): boolean {
  const { editor } = analysis.ctx;
  let node = value;

  for (;;) {
    const parent = editor.parentOf(node);
    if (!parent) {
      return false;
    }

    switch (parent.type) {
      // These hand the same value on, so where they stand decides.
      case 'LogicalExpression':
        node = parent;
        continue;
      case 'ConditionalExpression':
        if (parent.test === node) {
          return true;
        }
        node = parent;
        continue;

      // A spread copies the primitives, wherever it is.
      case 'SpreadElement':
      case 'BinaryExpression':
      case 'UnaryExpression':
      case 'ExpressionStatement':
        return true;

      case 'IfStatement':
        return parent.test === node;

      case 'ForInStatement':
      case 'ForOfStatement':
        return parent.right === node;

      case 'MemberExpression':
        return parent.property === node && parent.computed;

      // A tag is a function that gets the value itself.
      case 'TemplateLiteral':
        return editor.parentOf(parent)?.type !== 'TaggedTemplateExpression';

      case 'CallExpression':
        return parent.callee !== node && READING_FUNCTIONS.has(textOf(parent.callee));

      case 'NewExpression':
        return (
          parent.callee !== node &&
          parent.callee.type === 'Identifier' &&
          COPYING_CONSTRUCTORS.has(parent.callee.name)
        );

      case 'ArrayExpression':
      case 'Property':
        return isStoryConfig(node, analysis);

      default:
        if (isWrapper(parent)) {
          node = parent;
          continue;
        }
        return false;
    }
  }
}

/**
 * Whether a value written into an array or object literal ends up in what the file gives Storybook
 * as a meta or story: its default export, an exported story, or a CSF factory call. Storybook reads
 * those; a literal handed to anything else, or held by a binding the file does more with, may be
 * changed through it.
 */
function isStoryConfig(value: Node, analysis: Analysis): boolean {
  const { editor } = analysis.ctx;
  let node = value;

  for (;;) {
    const parent = editor.parentOf(node);
    if (!parent) {
      return false;
    }

    switch (parent.type) {
      case 'ArrayExpression':
      case 'ObjectExpression':
      case 'SpreadElement':
        node = parent;
        continue;

      case 'Property':
        if (parent.value !== node || editor.parentOf(parent)?.type !== 'ObjectExpression') {
          return false;
        }
        node = parent;
        continue;

      case 'ExportDefaultDeclaration':
        return true;

      case 'CallExpression': {
        const callee = unwrapExpression(parent.callee);
        return (
          parent.callee !== node &&
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.property.type === 'Identifier' &&
          FACTORY_METHODS.has(callee.property.name)
        );
      }

      case 'VariableDeclarator': {
        const holder =
          parent.init === node && parent.id.type === 'Identifier'
            ? editor.scopes.bindingOf(parent.id)
            : undefined;
        return (
          holder !== undefined &&
          holder.scope === editor.scopes.program &&
          holdsStoryConfig(holder, analysis)
        );
      }

      default:
        if (isWrapper(parent)) {
          node = parent;
          continue;
        }
        return false;
    }
  }
}

// Whether a binding that holds a literal is only ever given to Storybook: exported, named in a
// type, called as a CSF factory, or written into another story config, as `...Primary.args` is.
function holdsStoryConfig(binding: Binding, analysis: Analysis): boolean {
  if (!binding.constant) {
    return false;
  }
  if (analysis.visiting.has(binding)) {
    return true;
  }

  analysis.visiting.add(binding);
  const given = binding.references.every((reference) => {
    if (reference.type !== 'Identifier') {
      return isExport(reference);
    }
    const { read, depth, parent } = memberRead(reference, analysis.ctx);
    if (!parent) {
      return false;
    }
    if (isTypePosition(parent) || isExport(parent)) {
      return true;
    }
    if (parent.type === 'CallExpression' && parent.callee === read) {
      const callee = unwrapExpression(read);
      return (
        depth === 1 &&
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        FACTORY_METHODS.has(callee.property.name)
      );
    }
    return (
      (parent.type === 'SpreadElement' ||
        parent.type === 'ArrayExpression' ||
        parent.type === 'Property') &&
      isStoryConfig(read, analysis)
    );
  });
  analysis.visiting.delete(binding);
  return given;
}
