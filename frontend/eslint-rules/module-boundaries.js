// Local ESLint rule that keeps frontend modules apart.
//
// Each relative import is resolved against the importing file, so the check does not depend on
// how many "../" segments an import has:
// - a file may import anything inside its own module (e.g. modules/campus/shaping -> ../components/X);
// - another module may be imported only through its root (index.ts), e.g. "../grades";
// - src/shared must not import any module.
import path from "node:path";

const MODULES_SEGMENT = "/src/modules/";
const SHARED_SEGMENT = "/src/shared/";
const INDEX_NAMES = new Set(["index", "index.ts", "index.tsx"]);

function normalize(file) {
  return file.replace(/\\/g, "/");
}

/** Returns { root, name, rest } when the absolute path lies under src/modules/<name>. */
function locateModule(absPath) {
  const at = absPath.lastIndexOf(MODULES_SEGMENT);
  if (at === -1) return null;
  const after = absPath.slice(at + MODULES_SEGMENT.length);
  const [name, ...rest] = after.split("/");
  if (!name) return null;
  return { root: absPath.slice(0, at), name, rest: rest.filter(Boolean) };
}

function check(context, node, source) {
  if (!source || typeof source.value !== "string") return;
  const spec = source.value;
  const filename = normalize(context.filename ?? context.getFilename());

  // Bare specifiers (packages) never point into src; only relative paths can cross modules.
  // An import string that names modules/<x>/<y> directly is still reported.
  let target;
  if (spec.startsWith(".")) {
    // join (not resolve) so Windows drive paths are not mixed with the working directory.
    target = path.posix.join(path.posix.dirname(filename), spec);
  } else if (/(^|\/)modules\/[^/]+\/[^/]+/.test(spec)) {
    target = `/src/${spec.slice(spec.indexOf("modules/"))}`;
  } else {
    return;
  }

  const to = locateModule(target);
  if (!to) return;

  if (filename.includes(SHARED_SEGMENT)) {
    context.report({ node: source, messageId: "sharedImportsModule", data: { module: to.name } });
    return;
  }

  const from = locateModule(filename);
  if (from && from.name === to.name) return;

  const isRoot = to.rest.length === 0 || (to.rest.length === 1 && INDEX_NAMES.has(to.rest[0]));
  if (!isRoot) {
    context.report({ node: source, messageId: "deepImport", data: { module: to.name } });
  }
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Modules are imported only through their index.ts." },
    schema: [],
    messages: {
      deepImport: 'Import module "{{module}}" through its index.ts, not its internal files.',
      sharedImportsModule: 'src/shared must not import module "{{module}}".',
    },
  },
  create(context) {
    return {
      ImportDeclaration: (node) => check(context, node, node.source),
      ExportNamedDeclaration: (node) => check(context, node, node.source),
      ExportAllDeclaration: (node) => check(context, node, node.source),
      ImportExpression: (node) => check(context, node, node.source),
    };
  },
};
