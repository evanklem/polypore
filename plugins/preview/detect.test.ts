import { describe, expect, test } from 'vitest';
import { HostRpcServer } from '../../packages/host/src';
import { createLoopbackHost } from '../../packages/sdk/src/host';
import {
  applyUrlOverrideToCommand,
  detectRuntimes,
  extractPreviewUrl,
  inferKindFromScript,
  isLinuxLauncherNativeCommand,
  isMacOpenNativeCommand,
  isNativeExecutableCommand,
  isPackageExecNativeCommand,
  isWindowsShellNativeCommand,
  parseHostPort,
} from './detect';

/* detection runs against the same loopback host the panel uses, but
   without mounting the component — failures here point at detect.ts,
   not at panel rendering. */
function hostWithFiles(files: Record<string, string>) {
  const server = new HostRpcServer({ files });
  return createLoopbackHost(
    (request) => server.handle(request),
    (topic, fn) => server.subscribe(topic, fn),
  );
}

describe('runtime detection', () => {
  test('project-declared runtime commands come before auto-detected runtimes', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      '.polypore/runtime.json': JSON.stringify({
        runtimes: [{
          label: 'roc app',
          defaultUrl: 'http://localhost:8000',
          commands: [{ name: 'dev', command: 'roc run app.roc', kind: 'site' }],
        }],
      }),
      'package.json': JSON.stringify({
        name: 'node-client',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
    }));

    expect(runtimes[0].label).toBe('roc app');
    expect(runtimes[0].source).toBe('.polypore/runtime.json');
    expect(runtimes[0].defaultUrl).toBe('http://localhost:8000');
    expect(runtimes[0].scripts[0]).toMatchObject({ command: 'roc run app.roc', kind: 'site' });
    expect(runtimes[1].label).toBe('node · node-client');
  });

  test('node scripts use the project package manager', async () => {
    const declared = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'pnpm-client',
        packageManager: 'pnpm@9.0.0',
        scripts: { dev: 'vite --host 127.0.0.1 --port 1420' },
      }),
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    }));
    expect(declared[0].scripts[0].command).toBe('pnpm run dev');

    const fromLockfile = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'yarn-client',
        scripts: { dev: 'vite' },
      }),
      'yarn.lock': '# yarn lockfile v1\n',
    }));
    expect(fromLockfile[0].scripts[0].command).toBe('yarn run dev');
  });

  test('tauri scripts classify as desktop and pick up the devUrl from src-tauri config', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'desktop-only',
        scripts: { app: 'tauri dev' },
      }),
      'src-tauri/tauri.conf.json': JSON.stringify({ build: { devUrl: 'http://127.0.0.1:1420' } }),
    }));

    expect(runtimes[0].scripts[0]).toMatchObject({ command: 'npm run app', kind: 'desktop' });
    expect(runtimes[0].defaultUrl).toBe('http://127.0.0.1:1420');
  });

  test('tauri devUrl resolves from a root config file', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'root-tauri-config',
        scripts: { app: 'tauri dev' },
      }),
      'tauri.conf.json': JSON.stringify({ build: { devUrl: 'http://127.0.0.1:1430' } }),
    }));
    expect(runtimes[0].defaultUrl).toBe('http://127.0.0.1:1430');
  });

  test('tauri devUrl resolves from json5 and toml configs', async () => {
    const json5 = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'json5-tauri-config',
        scripts: { app: 'tauri dev' },
      }),
      'src-tauri/tauri.conf.json5': `{
        // development URL
        "build": {
          "devUrl": "http://127.0.0.1:1440",
        },
      }`,
    }));
    expect(json5[0].defaultUrl).toBe('http://127.0.0.1:1440');

    const toml = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'toml-tauri-config',
        scripts: { app: 'tauri dev' },
      }),
      'src-tauri/Tauri.toml': '[build]\ndevUrl = "http://127.0.0.1:1450"\n',
    }));
    expect(toml[0].defaultUrl).toBe('http://127.0.0.1:1450');
  });

  test('rust tauri crates surface cargo tauri dev as a desktop runtime', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'Cargo.toml': '[package]\nname = "rust-tauri-app"\nversion = "0.1.0"\n[dependencies]\ntauri = "2"\n',
      'src-tauri/tauri.conf.json': JSON.stringify({ build: { devUrl: 'http://127.0.0.1:1420' } }),
    }));

    expect(runtimes[0].scripts[0]).toMatchObject({ command: 'cargo tauri dev', kind: 'desktop' });
    expect(runtimes[0].defaultUrl).toBe('http://127.0.0.1:1420');
  });

  test('python pyproject app scripts become python -m commands with cli kind', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'pyproject.toml': '[project]\nname = "python-gui"\n[project.scripts]\napp = "python_gui.main:main"\n',
    }));
    expect(runtimes[0].scripts[0]).toMatchObject({ command: 'python -m python_gui.main', kind: 'cli' });
  });

  test('makefile launch targets with native commands classify as desktop', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      Makefile: '.PHONY: launch test\nlaunch:\n\tcalculator --debug\n\ntest:\n\tpytest\n',
    }));
    expect(runtimes[0].scripts[0]).toMatchObject({ name: 'launch', command: 'make launch', kind: 'desktop' });
  });

  test('justfile app recipes with native commands classify as desktop', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      justfile: 'app:\n\tcalculator --debug\n\ntest:\n\tpytest\n',
    }));
    expect(runtimes[0].scripts[0]).toMatchObject({ name: 'app', command: 'just app', kind: 'desktop' });
  });

  test('app-like targets rank ahead of test targets', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      justfile: 'test:\n\tpytest\n\nlaunch:\n\tcalculator\n',
    }));
    expect(runtimes[0].scripts[0].name).toBe('launch');
  });

  test('taskfile app tasks classify by their first command', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'Taskfile.yml': 'version: "3"\ntasks:\n  test:\n    cmds:\n      - pytest\n  app:\n    cmds:\n      - calculator --debug\n',
    }));
    expect(runtimes[0].scripts[0]).toMatchObject({ name: 'app', command: 'task app', kind: 'desktop' });
  });

  test('alternate task runner manifest filenames are detected', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'Taskfile.yaml': 'version: "3"\ntasks:\n  launch:\n    cmds:\n      - calculator\n',
    }));
    expect(runtimes[0].scripts[0]).toMatchObject({ name: 'launch', command: 'task launch', kind: 'desktop' });
  });

  const manifestCases: Array<{
    label: string;
    files: Record<string, string>;
    command: string;
    url?: string;
  }> = [
    {
      label: 'Maven Spring Boot',
      files: {
        'pom.xml': '<project><artifactId>orders</artifactId><build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build></project>',
      },
      command: 'mvn spring-boot:run',
      url: 'http://localhost:8080',
    },
    {
      label: 'Rails',
      files: {
        Gemfile: 'gem "rails"\n',
        'config/application.rb': 'module Shop\n  class Application < Rails::Application\n  end\nend\n',
      },
      command: 'bundle exec rails server',
      url: 'http://localhost:3000',
    },
    {
      label: 'Laravel',
      files: {
        'composer.json': JSON.stringify({
          name: 'shop/api',
          require: { 'laravel/framework': '^11.0' },
        }),
        artisan: '#!/usr/bin/env php\n',
      },
      command: 'php artisan serve',
      url: 'http://localhost:8000',
    },
    {
      label: '.NET web',
      files: {
        'Shop.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>',
      },
      command: 'dotnet run',
      url: 'http://localhost:5000',
    },
    {
      label: 'Docker Compose',
      files: {
        'compose.yml': 'services:\n  web:\n    image: nginx\n',
      },
      command: 'docker compose up',
    },
  ];

  test.each(manifestCases)('detects $label runtime manifests', async ({ files, command, url }) => {
    const runtimes = await detectRuntimes(hostWithFiles(files));
    expect(runtimes[0].scripts[0].command).toBe(command);
    if (url) expect(runtimes[0].defaultUrl).toBe(url);
  });

  test('go modules surface go run as an embeddable cli command', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'go.mod': 'module example.com/guiapp\n\ngo 1.22\n',
    }));
    expect(runtimes[0].scripts[0]).toMatchObject({ command: 'go run .', kind: 'cli' });
  });

  test('desktop app scripts classify as desktop', async () => {
    const electron = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'electron-client',
        scripts: { electron: 'electron .' },
      }),
    }));
    expect(electron[0].scripts[0]).toMatchObject({ command: 'npm run electron', kind: 'desktop' });

    const launchArgs = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'native-launch-args',
        scripts: { launch: 'calculator --debug' },
      }),
    }));
    expect(launchArgs[0].scripts[0]).toMatchObject({ command: 'npm run launch', kind: 'desktop' });
  });

  test('mobile simulator scripts classify as mobile', async () => {
    const runtimes = await detectRuntimes(hostWithFiles({
      'package.json': JSON.stringify({
        name: 'mobile-app',
        scripts: { ios: 'expo run:ios --simulator', android: 'expo run:android --emulator' },
      }),
    }));
    const kinds = Object.fromEntries(runtimes[0].scripts.map((script) => [script.name, script.kind]));
    expect(kinds.ios).toBe('mobile');
    expect(kinds.android).toBe('mobile');
  });
});

describe('native command classification', () => {
  test('bare executables with arguments are native', () => {
    expect(isNativeExecutableCommand('calculator --debug')).toBe(true);
    expect(inferKindFromScript('', 'calculator --debug')).toBe('desktop');
  });

  test('quoted executable paths with spaces are native', () => {
    const command = '"C:\\Program Files\\Native App\\app.exe" --debug';
    expect(isNativeExecutableCommand(command)).toBe(true);
    expect(inferKindFromScript('', command)).toBe('desktop');
  });

  test('env-prefixed desktop commands are native', () => {
    expect(isNativeExecutableCommand('env ELECTRON_ENABLE_LOGGING=1 electron .')).toBe(true);
    expect(inferKindFromScript('', 'env ELECTRON_ENABLE_LOGGING=1 electron .')).toBe('desktop');
  });

  test('package exec desktop commands are native', () => {
    expect(isPackageExecNativeCommand('npx electron .')).toBe(true);
    expect(inferKindFromScript('', 'npx electron .')).toBe('desktop');
  });

  test('macOS open app launchers are native, open URL commands are not', () => {
    expect(isMacOpenNativeCommand('open -a Calculator')).toBe(true);
    expect(inferKindFromScript('', 'open -a Calculator')).toBe('desktop');
    expect(isMacOpenNativeCommand('open http://localhost:9400')).toBe(false);
    expect(inferKindFromScript('', 'open http://localhost:9400')).not.toBe('desktop');
  });

  test('windows shell Start-Process launchers are native', () => {
    const command = 'powershell -NoProfile -Command "Start-Process \'C:\\Program Files\\Native App\\app.exe\'"';
    expect(isWindowsShellNativeCommand(command)).toBe(true);
    expect(inferKindFromScript('', command)).toBe('desktop');
  });

  test('linux app launchers are native, xdg-open URLs are not', () => {
    expect(isLinuxLauncherNativeCommand('flatpak run org.example.NativeApp')).toBe(true);
    expect(inferKindFromScript('', 'flatpak run org.example.NativeApp')).toBe('desktop');
    expect(isLinuxLauncherNativeCommand('xdg-open http://localhost:9500')).toBe(false);
    expect(inferKindFromScript('', 'xdg-open http://localhost:9500')).not.toBe('desktop');
  });
});

describe('url helpers', () => {
  test('parseHostPort reads host and port from a typed url', () => {
    expect(parseHostPort('http://127.0.0.1:1420')).toEqual({ host: '127.0.0.1', port: '1420' });
    expect(parseHostPort('http://localhost')).toBeNull();
    expect(parseHostPort('')).toBeNull();
  });

  test('applyUrlOverrideToCommand replaces flags in place or appends after --', () => {
    expect(applyUrlOverrideToCommand('vite --host 0.0.0.0 --port 1420', { host: '127.0.0.1', port: '1423' }))
      .toBe('vite --host 127.0.0.1 --port 1423');
    expect(applyUrlOverrideToCommand('npm run dev', { host: '127.0.0.1', port: '1420' }))
      .toBe('npm run dev -- --host 127.0.0.1 --port 1420');
    expect(applyUrlOverrideToCommand('python manage.py runserver', { host: '127.0.0.1', port: '1420' }))
      .toBe('python manage.py runserver');
  });

  test('applyUrlOverrideToCommand leaves a forwarded subcommand alone', () => {
    /* `npm run tauri -- dev` forwards `dev` to the tauri CLI. Appending
       --host/--port to that group lands them on `tauri dev`, which rejects
       them (it needs a second `--` to reach vite). We can't safely inject, so
       the command must come back unchanged rather than mangled. */
    expect(applyUrlOverrideToCommand('npm run tauri -- dev', { host: '127.0.0.1', port: '1420' }))
      .toBe('npm run tauri -- dev');
    /* but a `--` that already forwards dev-server flags is still safe to
       extend. */
    expect(applyUrlOverrideToCommand('npm run dev -- --port 1420', { host: '127.0.0.1', port: '1423' }))
      .toBe('npm run dev -- --port 1423 --host 127.0.0.1');
  });

  test('extractPreviewUrl pulls the first local url out of process output', () => {
    expect(extractPreviewUrl('opened http://localhost:9400\n')).toBe('http://localhost:9400');
    expect(extractPreviewUrl('listening on http://0.0.0.0:8080/admin')).toBe('http://localhost:8080/admin');
    expect(extractPreviewUrl('no url here')).toBe('');
  });
});
