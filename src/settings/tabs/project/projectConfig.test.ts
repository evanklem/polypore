import { describe, expect, test } from 'vitest';
import {
  diagnosticsEntryFromForm,
  fileTreeConfigFromForm,
  formatterEntryFromForm,
  normalizeDiagnosticsConfig,
  normalizeVerifyCommands,
  runtimeEntryFromForm,
  serverEntryFromForm,
  splitArgs,
  verifyEntryFromForm,
  EMPTY_RUNTIME_FORM,
  EMPTY_SERVER_FORM,
} from './projectConfig';

describe('projectConfig builders', () => {
  test('runtimeEntryFromForm derives a command name and drops empties', () => {
    expect(runtimeEntryFromForm({ ...EMPTY_RUNTIME_FORM, command: '' })).toBeNull();
    expect(runtimeEntryFromForm({ label: 'web', commandName: '', command: 'npm run dev', kind: 'site', url: '' })).toEqual({
      label: 'web',
      hint: undefined,
      defaultUrl: undefined,
      commands: [{ name: 'npm', command: 'npm run dev', kind: 'site' }],
    });
  });

  test('serverEntryFromForm requires a matcher and compacts empty fields', () => {
    expect(serverEntryFromForm({ ...EMPTY_SERVER_FORM, id: 'x', command: 'y' })).toEqual({
      error: 'language server needs extensions or filenames',
    });
    expect(serverEntryFromForm({ id: 'roc-lsp', command: 'roc_ls', args: '--stdio', extensions: '.roc', filenames: '', languageIds: 'roc=roc' })).toEqual({
      id: 'roc-lsp',
      command: 'roc_ls',
      args: ['--stdio'],
      extensions: ['roc'],
      languageIds: { roc: 'roc' },
    });
  });

  test('diagnosticsEntryFromForm omits the default parser', () => {
    expect(diagnosticsEntryFromForm({ id: 'd', command: 'c', parser: 'generic-colon', deep: false })).toEqual({ id: 'd', command: 'c' });
    expect(diagnosticsEntryFromForm({ id: 'd', command: 'c', parser: 'tsc', deep: true })).toEqual({ id: 'd', command: 'c', parser: 'tsc', deep: true });
  });

  test('formatterEntryFromForm strips leading dots from extensions', () => {
    expect(formatterEntryFromForm({ id: 'p', command: 'prettier', label: '', extensions: '.ts, .tsx', filenames: '' })).toEqual({
      id: 'p',
      label: 'p',
      command: 'prettier',
      extensions: ['ts', 'tsx'],
    });
  });

  test('verify + file-tree builders round-trip through their normalizers', () => {
    const verify = verifyEntryFromForm({ id: 'tc', command: 'tsc', label: '', required: true });
    expect(normalizeVerifyCommands([verify])).toEqual([{ id: 'tc', label: 'tc', command: 'tsc', required: true }]);

    expect(fileTreeConfigFromForm({ includeDirs: 'src', excludeDirs: 'dist, node_modules', textExtensions: '.roc', binaryExtensions: '' })).toEqual({
      includeDirs: ['src'],
      excludeDirs: ['dist', 'node_modules'],
      textExtensions: ['roc'],
    });
  });

  test('splitArgs respects quoted segments', () => {
    expect(splitArgs('--port 0 "two words" \'three\'')).toEqual(['--port', '0', 'two words', 'three']);
  });

  test('normalizeDiagnosticsConfig accepts a bare array', () => {
    expect(normalizeDiagnosticsConfig([{ id: 'a', command: 'b' }])).toEqual({ sources: [{ id: 'a', command: 'b' }] });
  });
});
