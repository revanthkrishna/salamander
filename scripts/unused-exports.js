#!/usr/bin/env node
// scripts/unused-exports.js — report-only (`npm run lint:exports`).
// Lists every export in src/ (tests excluded) that no other production
// module imports: either nothing uses it at all, or only the tests do. A
// test seam is expected in the second list (name it `_…ForTests`); anything
// else there, or anything in the first, is a candidate for removal or for
// losing its `export`. Exits 0 either way: it informs, it does not gate.

'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const SRC = path.resolve(__dirname, '../src');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

const files = walk(SRC);
const isTest = (f) => f.includes(`${path.sep}__tests__${path.sep}`);
const prod = files.filter((f) => !isTest(f));

function resolve(from, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [`${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(cand)) return cand;
  return null;
}

/** name -> Set of exporting files is not needed; per file, its exported names. */
const exportsOf = new Map();
/** file -> Map(importedFile -> Set(names) | '*namespace*' alias) */
function parse(file) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const exported = new Set();
  const uses = []; // [targetFile, name]
  const namespaces = []; // [alias, targetFile]
  for (const st of sf.statements) {
    const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
    const isExport = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (isExport) {
      if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) exported.add(d.name.getText(sf));
      else if (st.name) exported.add(st.name.getText(sf));
    }
    if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      const target = st.moduleSpecifier ? resolve(file, st.moduleSpecifier.text) : null;
      for (const el of st.exportClause.elements) {
        exported.add(el.name.text);
        if (target) uses.push([target, (el.propertyName ?? el.name).text]);
      }
    }
    if (ts.isImportDeclaration(st)) {
      const target = resolve(file, st.moduleSpecifier.text);
      const clause = st.importClause;
      if (!target || !clause) continue;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) uses.push([target, (el.propertyName ?? el.name).text]);
      } else if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        namespaces.push([clause.namedBindings.name.text, target]);
      }
    }
  }
  const text = sf.getFullText();
  for (const [alias, target] of namespaces) {
    for (const m of text.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)`, 'g'))) uses.push([target, m[1]]);
  }
  // A namespace object handed on whole (`sidebar,` as a dependency) uses
  // what its receiver picks; count those receivers' Pick<> names too.
  for (const m of text.matchAll(/typeof\s+(\w+)\s*,\s*((?:\s*\|?\s*'[\w$]+')+)/g)) {
    const ns = namespaces.find(([alias]) => alias === m[1]);
    if (!ns) continue;
    for (const n of m[2].matchAll(/'([\w$]+)'/g)) uses.push([ns[1], n[1]]);
  }
  return { exported, uses };
}

const parsed = new Map(files.map((f) => [f, parse(f)]));
// Pick<typeof X, 'a' | 'b'> in `import type * as X` files.
const usedBy = new Map(); // `${file}#${name}` -> { prod: bool, test: bool }
for (const [file, { uses }] of parsed) {
  for (const [target, name] of uses) {
    if (target === file) continue;
    const key = `${target}#${name}`;
    const u = usedBy.get(key) ?? { prod: false, test: false };
    if (isTest(file)) u.test = true;
    else u.prod = true;
    usedBy.set(key, u);
  }
}

const unused = [];
const testOnly = [];
for (const file of prod) {
  for (const name of parsed.get(file).exported) {
    const u = usedBy.get(`${file}#${name}`);
    const rel = `${path.relative(SRC, file)}: ${name}`;
    if (file.endsWith(`${path.sep}background.ts`) || file.endsWith(`${path.sep}content.ts`)) {
      // Entry points: their exports exist for the tests by design.
      if (!u?.prod) testOnly.push(rel);
      continue;
    }
    if (!u) unused.push(rel);
    else if (!u.prod) testOnly.push(rel);
  }
}
console.log(`Exports nothing imports (${unused.length}):`);
for (const x of unused) console.log(`  ${x}`);
console.log(`\nExports only the tests import (${testOnly.length}):`);
for (const x of testOnly) console.log(`  ${x}`);
