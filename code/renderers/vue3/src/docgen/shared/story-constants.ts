import {
  type ESTreeNode as Node,
  type ReferenceContext,
  textOf,
  unwrapExpression,
  walk,
} from 'storybook/internal/csf-tools';

import {
  isFunctionExpression,
  isResolvable,
  printValue,
  RESOLVABLE_GLOBALS,
} from './classify-value.ts';
import { collectFreeExpression } from './free-names.ts';
import { unchangingKind } from './read-only-binding.ts';

/** A constant the story file declares at module level, which a snippet can declare again. */
export interface StoryConstant {
  /** The value it is declared with, as the snippet prints it. */
  source: string;
  /** The other story constants that value reads, which the snippet declares before it. */
  uses: string[];
  /** Where the story file declares it, which orders the snippet's declarations. */
  start: number;
}

/** The story-file constants a story's arg values read, which its snippet can declare. */
export interface StoryConstants {
  /** Each constant the snippet can declare, by name. */
  declarations: ReadonlyMap<string, StoryConstant>;
  /** The names of the constants an arg value reads, and of those they read in turn. */
  names: ReadonlySet<string>;
  /**
   * The constants a value reads. None for a value another module wrote, whose names mean what
   * that module declares, and none for a value written in syntax this pass does not read.
   */
  readBy: (value: Node) => ReadonlySet<string>;
  /**
   * The constant a value is the declared value of, which an arg written as that constant's name
   * resolves to. The snippet binds such an arg to the constant, so it stays the same value every
   * other read of the constant sees.
   */
  declaredAs: (value: Node) => string | undefined;
}

const NO_NAMES: ReadonlySet<string> = new Set();

export const NO_STORY_CONSTANTS: StoryConstants = {
  declarations: new Map(),
  names: NO_NAMES,
  readBy: () => NO_NAMES,
  declaredAs: () => undefined,
};

// The Vue import a snippet adds for a `v-model`, which no constant it declares may shadow.
const SNIPPET_IMPORTS: ReadonlySet<string> = new Set(['ref']);

/**
 * The module-level constants the story's arg values read, each with the constants it reads in turn.
 *
 * An arg written as `lines.length` or as `` `<pre>${lines.join('\n')}</pre>` `` means nothing where
 * the snippet lands unless `lines` is declared there too, so the snippet carries the declaration
 * over. Only a binding whose value cannot have changed by the time the story renders, see
 * `unchangingKind`, and whose value the snippet can print, qualifies. An import, a destructured
 * name, a binding that holds an object the file could change, a value written with a type the
 * story file declares, and a value reading one of those are left for the caller to report. So is
 * every name in `taken`, which the story's render declares as something else.
 *
 * @example `const lines = ['a']; args: { count: lines.length }` → `lines` declared as `['a']`
 */
export function collectStoryConstants(
  args: Record<string, Node>,
  ctx: ReferenceContext,
  taken: ReadonlySet<string> = NO_NAMES
): StoryConstants {
  const declarations = new Map<string, StoryConstant>();
  const values = new WeakMap<Node, string>();
  const rejected = new Set<string>();
  const { editor } = ctx;
  const bindings = editor.scopes.program.bindings;

  // Whether the story file wrote the node. A value copied out of another module, or rebuilt from
  // rewritten source, reads names this file's bindings say nothing about.
  const owned = (node: Node): boolean => editor.parentOf(node) !== null;

  // The names an expression reads from the scope it is written in, but JavaScript's globals. A
  // global the story file declares over is the story file's.
  const referencedNames = (node: Node): string[] | undefined => {
    const free = new Set<string>();
    if (!collectFreeExpression(node, NO_NAMES, free)) {
      return undefined;
    }
    return [...free].filter((name) => bindings.has(name) || !RESOLVABLE_GLOBALS.has(name));
  };

  const declarable = (name: string, visiting: Set<string>): boolean => {
    if (declarations.has(name)) {
      return true;
    }
    // A constant that reads itself, directly or through another, has no order to be declared in.
    if (rejected.has(name) || visiting.has(name) || taken.has(name) || SNIPPET_IMPORTS.has(name)) {
      return false;
    }

    const binding = bindings.get(name);
    const declarator =
      binding?.node.type === 'VariableDeclarator' && unchangingKind(binding, ctx) !== undefined
        ? binding.node
        : undefined;
    const init = declarator?.init ? unwrapExpression(declarator.init) : undefined;
    const uses = init && !namesStoryFileType(init, ctx) ? referencedNames(init) : undefined;
    if (!declarator?.init || !init || !uses) {
      rejected.add(name);
      return false;
    }

    visiting.add(name);
    const readable =
      uses.every((used) => declarable(used, visiting)) &&
      (isFunctionExpression(init) || isResolvable(init, new Set(uses)));
    visiting.delete(name);
    if (!readable) {
      rejected.add(name);
      return false;
    }

    declarations.set(name, {
      // `as const` names no type of the story file, and without it the value's type is wider.
      source: printValue(isConstAssertion(declarator.init) ? declarator.init : init),
      uses,
      start: (declarator as Node & { start: number }).start,
    });
    values.set(init, name);
    return true;
  };

  // All or nothing: a value that also reads a name of the story file the snippet cannot declare
  // is not one it can print, whatever else it reads.
  const readBy = (value: Node): ReadonlySet<string> => {
    const unwrapped = unwrapExpression(value);
    const names =
      owned(unwrapped) && !namesStoryFileType(unwrapped, ctx)
        ? referencedNames(unwrapped)?.filter((name) => bindings.has(name))
        : undefined;
    return names?.every((name) => declarable(name, new Set())) ? new Set(names) : NO_NAMES;
  };

  // Every arg is read up front, so the snippet knows each name it may come to declare before it
  // names anything else.
  const names = new Set<string>();
  const name = (constant: string): void => {
    if (!names.has(constant)) {
      names.add(constant);
      declarations.get(constant)?.uses.forEach(name);
    }
  };
  for (const value of Object.values(args)) {
    readBy(value).forEach(name);
  }

  return {
    declarations,
    names,
    readBy,
    declaredAs: (value) => {
      const constant = values.get(unwrapExpression(value));
      return constant !== undefined && names.has(constant) ? constant : undefined;
    },
  };
}

const isConstAssertion = (node: Node): boolean =>
  node.type === 'TSAsExpression' && textOf(node.typeAnnotation) === 'const';

/**
 * Whether a value is written with a type the story file declares or imports, as in
 * `[] as Item[]` or `(item: Item) => item.name`. The snippet has no declaration for that type, so
 * the value would not type-check there.
 */
function namesStoryFileType(node: Node, { editor }: ReferenceContext): boolean {
  const { tsDeclarationNames, program } = editor.scopes;
  let named = false;
  walk(node, (child) => {
    if (named) {
      return false;
    }
    if (child.type === 'TSTypeReference' || child.type === 'TSTypeQuery') {
      // `Item` in `Item`, `Shapes` in `Shapes.Item`, `config` in `typeof config`.
      const root = /^[\w$]+/.exec(
        textOf(child.type === 'TSTypeReference' ? child.typeName : child.exprName)
      )?.[0];
      named = root !== undefined && (tsDeclarationNames.has(root) || program.bindings.has(root));
    }
  });
  return named;
}
