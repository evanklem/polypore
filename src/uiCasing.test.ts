import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function productionFiles(root: string, extension: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '_mockup-render' || entry.name === '_devpreview') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...productionFiles(full, extension));
    else if (entry.name.endsWith(extension) && !entry.name.includes('.test.')) files.push(full);
  }
  return files;
}

describe('ui casing', () => {
  test('manual prose renders lowercase without altering code examples', () => {
    const css = readFileSync(path.join(process.cwd(), 'src/manual/manual-surface.css'), 'utf8');

    expect(css).toMatch(/\.manual-prose\s*{[^}]*text-transform:\s*lowercase;/s);
    expect(css).toMatch(/\.manual-prose code\s*{[^}]*text-transform:\s*none;/s);
  });

  test('production styles never force uppercase or title case', () => {
    const violations: string[] = [];

    for (const file of productionFiles(path.join(process.cwd(), 'src'), '.css')) {
      const css = readFileSync(file, 'utf8');
      css.split('\n').forEach((line, index) => {
        if (/text-transform:\s*(?:uppercase|capitalize)/.test(line)) {
          violations.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  test('authored jsx labels are lowercase', () => {
    const violations: string[] = [];
    const labelAttributes = new Set([
      'aria-label',
      'closeLabel',
      'description',
      'emptyLabel',
      'label',
      'message',
      'navLabel',
      'subtitle',
      'title',
    ]);
    const labelProperties = new Set(['blurb', 'ctaLabel', 'detail', 'hint', 'label', 'summary']);
    const roots = [path.join(process.cwd(), 'src'), path.join(process.cwd(), 'plugins')];

    const files = roots.flatMap((root) => [
      ...productionFiles(root, '.ts'),
      ...productionFiles(root, '.tsx'),
    ]);

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );

      const record = (node: ts.Node, value: string) => {
        const label = value.replace(/\s+/g, ' ').trim();
        if (!/[A-Z]/.test(label)) return;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        violations.push(`${path.relative(process.cwd(), file)}:${line + 1} "${label}"`);
      };

      const visit = (node: ts.Node) => {
        if (ts.isJsxText(node)) record(node, node.text);
        if (ts.isJsxAttribute(node) && labelAttributes.has(node.name.getText(sourceFile)) && node.initializer) {
          if (ts.isStringLiteral(node.initializer)) {
            record(node, node.initializer.text);
          } else {
            const recordStringLiterals = (child: ts.Node) => {
              if (ts.isStringLiteral(child)) record(child, child.text);
              ts.forEachChild(child, recordStringLiterals);
            };
            recordStringLiterals(node.initializer);
          }
        }
        if (ts.isPropertyAssignment(node) && labelProperties.has(node.name.getText(sourceFile))) {
          if (ts.isStringLiteralLike(node.initializer)) record(node, node.initializer.text);
        }
        ts.forEachChild(node, visit);
      };

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
