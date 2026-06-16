import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { BuiltinPluginProps } from '../shared';
import { ansiToText, PanelHeader, ResizeHandle, useResizableSplit } from '../shared';
import { PreviewTerminal } from './PreviewTerminal';
import {
  applyUrlOverrideToCommand,
  detectRuntimes,
  extractPreviewUrl,
  FALLBACK_RUNTIME,
  inferKindFromScript,
  inferScriptNameFromCommand,
  inferUrlFromScript,
  isLinuxLauncherNativeCommand,
  isMacOpenNativeCommand,
  isNativeExecutableCommand,
  isPackageExecNativeCommand,
  isWindowsShellNativeCommand,
  parseHostPort,
  readStoredRuntimePreference,
  readTauriDevUrl,
  runtimeKey,
  runtimePreferenceScope,
  storeRuntimePreference,
} from './detect';
import type { DetectedRuntime, DetectedScript, PreviewTargetKind } from './detect';

type CurrentRun = {
  command: string;
  url: string;
  kind: PreviewTargetKind;
  rawHint: string;
  /* tauri/electron/native-launcher commands stay labeled "embedded app
     preview" even when falling back to an iframe (their dev URL). heuristic
     'desktop' classifications (e.g. an unknown executable with a 'launch'
     script name) render as plain "embedded preview" in iframe fallback —
     they were a guess, not an assertion. */
  explicitNative: boolean;
};

export function PreviewPanel({ header, host }: BuiltinPluginProps) {
  const [scriptsWidth, onScriptsResize] = useResizableSplit({ axis: 'x', initial: 28, min: 18, max: 46 });
  const [runtimes, setRuntimes] = useState<DetectedRuntime[]>([]);
  const [runtime, setRuntime] = useState<DetectedRuntime | null>(null);
  const [selectedScript, setSelectedScript] = useState<string>('');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [mode, setMode] = useState<'window' | 'external'>('window');
  const [status, setStatus] = useState<'idle' | 'running' | 'external'>('idle');
  const [logsOpen, setLogsOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const logPaneRef = useRef<HTMLPreElement | null>(null);
  const logDrawerRef = useRef<HTMLPreElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [sessionId, setSessionId] = useState('');
  const [frameKey, setFrameKey] = useState(0);
  /* the frozen intent for the currently-active run. set in runInWindow/
     runOutside, cleared in stopPreview. while this is non-null, the
     rendered view is determined by currentRun.kind — not by ambient state
     like url-regex matches or preview.list rehydration. this is what
     prevents a cli/test run from being silently reclassified into a site
     iframe when a stray URL shows up. */
  const [currentRun, setCurrentRun] = useState<CurrentRun | null>(null);
  const commandRef = useRef('');
  const sessionIdRef = useRef('');
  const currentRunRef = useRef<CurrentRun | null>(null);
  /* tracks whether the user has interacted with the setup form. used to
     skip the preview.list() rehydration race that would otherwise clobber
     a fresh selection with the first-ever-registered target. */
  const userTouchedRef = useRef(false);
  const runtimePreferenceScopeRef = useRef('');

  const activeScript = useMemo(
    () => runtime?.scripts.find((script) => script.name === selectedScript) ?? null,
    [runtime, selectedScript],
  );
  const commandScript = useMemo(
    () => runtime?.scripts.find((script) => script.name === inferScriptNameFromCommand(command)) ?? null,
    [command, runtime],
  );
  const rawCommandHint = commandScript?.raw ?? (activeScript?.command === command ? activeScript.raw : undefined) ?? command;
  const inferredCommandKind = commandScript?.kind ?? inferKindFromScript(inferScriptNameFromCommand(command), command);
  /* setup-view kind: what the user is about to launch. used only for ui
     hints on the setup form. the running view reads from currentRun.kind. */
  const candidateKind = activeScript?.command === command ? activeScript.kind : inferredCommandKind;
  /* explicit native frameworks (tauri/electron/wails/...) ship a real OS
     window. their dev URL is the *frontend* served to that window, not
     the app. iframing it would silently swap the desktop runtime for a
     plain browser context — APIs missing, IPC missing — so we refuse to
     embed regardless of whether a URL was detected. */
  const candidateExplicitNative =
    /\b(tauri|electron|wails|neutralino|nw|nodewebkit|cargo\s+tauri)\b/i.test(`${command} ${rawCommandHint}`)
    || isNativeExecutableCommand(command)
    || isMacOpenNativeCommand(rawCommandHint)
    || isWindowsShellNativeCommand(rawCommandHint)
    || isLinuxLauncherNativeCommand(rawCommandHint)
    || isPackageExecNativeCommand(rawCommandHint);
  /* a run is embeddable in the panel iff it produces a surface the
     webview can host: an iframe (any url-having site/game/desktop) or
     a terminal (cli/test). pure-native gui (desktop with no devUrl,
     mobile simulators, native binaries) can't be embedded — only
     opened externally. */
  const canRunInWindow =
    !candidateExplicitNative
    && (
      candidateKind === 'cli'
      || candidateKind === 'test'
      || candidateKind === 'site'
      || candidateKind === 'game'
      || (candidateKind === 'desktop' && /https?:\/\//i.test(url))
    );
  const runInWindowReason = canRunInWindow
    ? ''
    : candidateExplicitNative
      ? 'this is a native desktop app — it launches its own OS window outside polypore'
      : candidateKind === 'mobile'
        ? 'mobile simulators always run as a separate window'
        : candidateKind === 'desktop'
          ? 'no embeddable url detected (raw native windows can\'t be hosted inside polypore)'
          : 'no embeddable surface detected for this command';
  const runUrlIsWebish = currentRun ? /https?:\/\//i.test(currentRun.url) : false;

  useEffect(() => {
    commandRef.current = command;
  }, [command]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    currentRunRef.current = currentRun;
  }, [currentRun]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([detectRuntimes(host), runtimePreferenceScope(host)]).then(([nextRuntimes, preferenceScope]) => {
      if (cancelled) return;
      runtimePreferenceScopeRef.current = preferenceScope;
      setRuntimes(nextRuntimes);
      const preferredKey = readStoredRuntimePreference(preferenceScope);
      const next = nextRuntimes.find((candidate) => runtimeKey(candidate) === preferredKey)
        ?? nextRuntimes[0]
        ?? FALLBACK_RUNTIME;
      setRuntime(next);
      const first = next.scripts[0];
      if (first && !userTouchedRef.current) {
        setSelectedScript(first.name);
        setCommand(first.command);
      }
      if (!userTouchedRef.current) setUrl(next.defaultUrl);
    });
    /* a previously registered preview target takes precedence — the user
       may have already edited the command for this project. but only if
       they haven't touched the form yet in this mount; otherwise this
       races their selection and clobbers it. */
    host.preview.list().then((result) => {
      if (cancelled || result.targets.length === 0 || userTouchedRef.current) return;
      const target = result.targets[result.targets.length - 1];
      setCommand(target.command);
      setUrl(target.target);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [host]);

  useEffect(() => host.terminal.onEvent((event) => {
    if (event.id !== sessionIdRef.current) return;
    if (event.kind === 'output' && event.data) {
      setLogs((current) => [...current, event.data ?? ''].slice(-400));
      /* gate URL promotion from stdout: cli/test runs never pick up URLs
         (a typecheck error mentioning http://localhost must not turn into
         an iframe). site/game/desktop/mobile may pick up URLs — a dev
         server printing its address, or a desktop heuristic that was
         actually a web target. */
      const run = currentRunRef.current;
      if (run && run.kind !== 'cli' && run.kind !== 'test') {
        const detectedUrl = extractPreviewUrl(event.data);
        if (detectedUrl) {
          setCurrentRun((prev) => {
            if (!prev) return prev;
            const prevPort = parseHostPort(prev.url)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = prevPort && detectedPort && prevPort !== detectedPort;
            const next = (!prev.url || portMismatch) ? { ...prev, url: detectedUrl } : prev;
            currentRunRef.current = next;
            return next;
          });
          setUrl((current) => {
            const currentPort = parseHostPort(current)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = currentPort && detectedPort && currentPort !== detectedPort;
            return (!current || portMismatch) ? detectedUrl : current;
          });
        }
      }
    }
    if (event.kind === 'exited') {
      setLogs((current) => [...current, `\n[process exited ${event.exitCode ?? 0}]\n`].slice(-400));
      setExitCode(event.exitCode ?? 0);
    }
  }), [host]);

  /* tail behavior: stick to the bottom of the log pane as new output
     arrives, but yield as soon as the user scrolls up to read history.
     a single threshold (~24px from the bottom) avoids fighting the user
     when they re-anchor by scrolling back down. */
  useEffect(() => {
    const node = logPaneRef.current;
    if (node && stickToBottomRef.current) node.scrollTop = node.scrollHeight;
    const drawerNode = logDrawerRef.current;
    if (drawerNode) drawerNode.scrollTop = drawerNode.scrollHeight;
  }, [logs]);

  const pickRuntime = (nextRuntime: DetectedRuntime) => {
    userTouchedRef.current = true;
    persistRuntimePreference(nextRuntime);
    setRuntime(nextRuntime);
    const first = nextRuntime.scripts[0];
    setSelectedScript(first?.name ?? '');
    commandRef.current = first?.command ?? '';
    setCommand(first?.command ?? '');
    setUrl(nextRuntime.defaultUrl);
  };

  const persistRuntimePreference = (nextRuntime: DetectedRuntime) => {
    const key = runtimeKey(nextRuntime);
    if (runtimePreferenceScopeRef.current) {
      storeRuntimePreference(runtimePreferenceScopeRef.current, key);
      return;
    }
    runtimePreferenceScope(host).then((scope) => {
      runtimePreferenceScopeRef.current = scope;
      storeRuntimePreference(scope, key);
    }).catch(() => {});
  };

  const pickScript = (script: DetectedScript) => {
    userTouchedRef.current = true;
    setSelectedScript(script.name);
    commandRef.current = script.command;
    setCommand(script.command);
    const inferredUrl = script.raw ? inferUrlFromScript(script) : '';
    if (inferredUrl) {
      setUrl(inferredUrl);
      return;
    }
    if (script.kind === 'desktop') {
      readTauriDevUrl(host).then((devUrl) => setUrl(devUrl)).catch(() => setUrl(''));
      return;
    }
    setUrl('');
  };

  const resolveUrlForCommand = async (nextCommand: string): Promise<string> => {
    const scriptName = inferScriptNameFromCommand(nextCommand);
    const matchingScript = runtime?.scripts.find((script) => script.name === scriptName);
    const inferredKind = matchingScript?.kind ?? inferKindFromScript(scriptName, nextCommand);
    const raw = matchingScript?.raw ?? nextCommand;
    const inferredUrl = inferUrlFromScript({
      name: scriptName,
      command: nextCommand,
      raw,
      kind: inferredKind,
    });
    if (inferredUrl) return inferredUrl;
    if (inferredKind === 'desktop' && /\b(?:tauri|cargo\s+tauri)\b/i.test(`${nextCommand} ${raw}`)) {
      return readTauriDevUrl(host);
    }
    return '';
  };

  const changeCommand = (nextCommand: string) => {
    userTouchedRef.current = true;
    commandRef.current = nextCommand;
    setCommand(nextCommand);
    const scriptName = inferScriptNameFromCommand(nextCommand);
    const matchingScript = runtime?.scripts.find((script) => script.name === scriptName);
    const inferredKind = matchingScript?.kind ?? inferKindFromScript(scriptName, nextCommand);
    const raw = matchingScript?.raw ?? nextCommand;
    const immediateUrl = inferUrlFromScript({
      name: scriptName,
      command: nextCommand,
      raw,
      kind: inferredKind,
    });
    if (immediateUrl) {
      setUrl(immediateUrl);
    } else if (!(inferredKind === 'desktop' && /\b(?:tauri|cargo\s+tauri)\b/i.test(`${nextCommand} ${raw}`))) {
      setUrl('');
    }
    resolveUrlForCommand(nextCommand)
        .then((devUrl) => {
          if (commandRef.current === nextCommand) setUrl(devUrl);
        })
        .catch(() => {
          if (commandRef.current === nextCommand) setUrl('');
        });
  };

  const registerOnHost = async (run: CurrentRun) => {
    await host.preview.register({
      label: runtime?.label ?? 'preview',
      command: run.command,
      target: run.url,
      kind: run.kind,
    });
  };

  const startCommand = async (run: CurrentRun) => {
    if (!run.command.trim()) return;
    if (sessionId) {
      await host.terminal.stop(sessionId).catch(() => {});
      sessionIdRef.current = '';
      setSessionId('');
    }
    setLogs([`$ ${run.command}\n`]);
    setExitCode(null);
    const result = await host.terminal.spawn(run.command);
    sessionIdRef.current = result.session.id;
    setSessionId(result.session.id);
    if (result.session.status === 'exited') setExitCode(result.session.exitCode ?? 0);
    if (result.session.output) {
      setLogs((current) => [...current, result.session.output].slice(-400));
      /* same gating as the streaming listener: cli/test never adopt URLs
         from stdout. */
      if (run.kind !== 'cli' && run.kind !== 'test') {
        const detectedUrl = extractPreviewUrl(result.session.output);
        if (detectedUrl) {
          setCurrentRun((prev) => {
            if (!prev) return prev;
            const prevPort = parseHostPort(prev.url)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = prevPort && detectedPort && prevPort !== detectedPort;
            const next = (!prev.url || portMismatch) ? { ...prev, url: detectedUrl } : prev;
            currentRunRef.current = next;
            return next;
          });
          setUrl((current) => {
            const currentPort = parseHostPort(current)?.port;
            const detectedPort = parseHostPort(detectedUrl)?.port;
            const portMismatch = currentPort && detectedPort && currentPort !== detectedPort;
            return (!current || portMismatch) ? detectedUrl : current;
          });
        }
      }
    }
  };

  /* freeze the user's intent for this launch into a CurrentRun. the
     running/external views render against this snapshot rather than the
     editable form state, so a stray URL or late preview.list rehydration
     can't reclassify a cli/test run into an embedded site iframe.

     a URL inside the command itself (e.g. `open http://...`, `xdg-open
     http://...`) is treated as intentional and promotes a cli to a site
     run — the user is explicitly asking to display a page. URLs that
     appear only in stdout don't promote cli/test runs; that was the bug. */
  const buildRun = async (): Promise<CurrentRun> => {
    /* user-typed URL wins, and is authoritative for what the dev server
       binds to — not just where the iframe loads. when the URL parses
       into a host+port, applyUrlOverrideToCommand rewrites the command
       so the spawned process actually listens there. for npm scripts
       without `--port` flags we pass through via `-- --port HOST` so
       the underlying tool (vite/next/etc) picks them up.

       empty URL means "no iframe, just run the command" — falls
       through to the embedded terminal view. */
    const inlineUrl = extractPreviewUrl(command);
    const finalUrl = url.trim() || inlineUrl;
    const override = parseHostPort(url);
    /* decide native-ness from the command as typed, before any rewrite:
       native runtimes (tauri/electron/...) manage their own dev server, so the
       host/port bind rewrite is meaningless for them and can corrupt their
       argv (e.g. appending vite's --host/--port onto `tauri dev`). skip the
       override entirely for native commands. */
    const commandAndRaw = `${command} ${rawCommandHint}`;
    const explicitNative = /\b(tauri|electron|wails|neutralino|nw|nodewebkit|cargo\s+tauri)\b/i.test(commandAndRaw)
      || isNativeExecutableCommand(command)
      || isMacOpenNativeCommand(rawCommandHint)
      || isWindowsShellNativeCommand(rawCommandHint)
      || isLinuxLauncherNativeCommand(rawCommandHint)
      || isPackageExecNativeCommand(rawCommandHint);
    const rewrittenCommand = override && !explicitNative ? applyUrlOverrideToCommand(command, override) : command;
    const promoteToSite = candidateKind === 'cli' && !!(url.trim() || inlineUrl);
    return {
      command: rewrittenCommand,
      url: finalUrl,
      kind: promoteToSite ? 'site' : candidateKind,
      rawHint: rawCommandHint,
      explicitNative,
    };
  };

  const runInWindow = async () => {
    userTouchedRef.current = true;
    setMode('window');
    setStatus('running');
    setLogsOpen(false);
    setFrameKey((key) => key + 1);
    const run = await buildRun();
    setUrl(run.url);
    currentRunRef.current = run;
    setCurrentRun(run);
    await registerOnHost(run).catch(() => {});
    await startCommand(run).catch((err) => {
      setLogs((current) => [...current, `${err instanceof Error ? err.message : String(err)}\n`]);
    });
  };

  const runOutside = async () => {
    userTouchedRef.current = true;
    setMode('external');
    setStatus('external');
    setLogsOpen(false);
    const run = await buildRun();
    setUrl(run.url);
    currentRunRef.current = run;
    setCurrentRun(run);
    await registerOnHost(run).catch(() => {});
    await startCommand(run).catch((err) => {
      setLogs((current) => [...current, `[spawn failed] ${err instanceof Error ? err.message : String(err)}\n`]);
      setExitCode((prev) => (prev ?? -1));
    });
    if (/https?:\/\//i.test(run.url) && run.kind !== 'desktop') await host.ui.openExternal(run.url).catch(() => {});
  };

  const refreshPreview = () => {
    setFrameKey((key) => key + 1);
    host.preview.refresh().catch(() => {});
  };

  const stopPreview = () => {
    if (sessionId) {
      host.terminal.stop(sessionId).catch(() => {});
      sessionIdRef.current = '';
      setSessionId('');
    }
    setStatus('idle');
    setLogsOpen(false);
    currentRunRef.current = null;
    setCurrentRun(null);
  };

  const runKind = currentRun?.kind ?? candidateKind;
  const runCommand = currentRun?.command ?? command;
  const runUrl = currentRun?.url ?? url;
  const statusLabel =
    status === 'idle' ? 'not running'
    : status === 'running' ? 'running in window'
    : runUrlIsWebish && runKind !== 'desktop' ? 'opened outside'
    : 'running outside';
  const scripts = runtime?.scripts ?? [];
  const hasScripts = scripts.length > 0;
  const headerBar = (
    <PanelHeader {...header}>
      <span className="panel-header__title">preview</span>
      <span className="panel-header__sep" aria-hidden="true" />
      <span className="panel-header__meta">{runtime?.label ?? 'detecting…'}</span>
      <span className={`panel-header__meta preview-status preview-status--${status}`}>{statusLabel}</span>
    </PanelHeader>
  );

  if (status === 'running' && mode === 'window') {
    /* the running view is driven by the frozen run snapshot:
       - cli/test never reclassify into an iframe even if a URL ends up in
         state. this is the bug we fixed: typecheck output incidentally
         mentioning http://localhost stops being treated as a website.
       - desktop/mobile/site/game fall back to iframe when a URL is known
         and the run is embeddable. */
    const allowIframe = runKind !== 'cli' && runKind !== 'test';
    /* when the spawned process has died non-zero, the iframe is
       guaranteed to be looking at a dead URL — show the error overlay
       instead of a blank embed. zero-exit + iframe stays embedded
       (some servers fork off and the parent exits cleanly). */
    const processFailed = exitCode !== null && exitCode !== 0;
    const showIframe = allowIframe && runUrlIsWebish && !processFailed;
    const headerLabel = processFailed
      ? `process exited ${exitCode}`
      : showIframe
        ? (currentRun?.explicitNative ? 'embedded app preview' : 'embedded preview')
        : `${runKind} output`;
    return (
      <div className="preview-surface preview-surface--running">
        {headerBar}
        <section className="preview-output preview-output--fullscreen">
          <header>
            <strong className={processFailed ? 'preview-output__status preview-output__status--failed' : undefined}>{headerLabel}</strong>
            <span>{runUrl || runCommand}</span>
            <div className="preview-output__controls">
              <button onClick={refreshPreview} title="reload the iframe">refresh</button>
              <button onClick={() => void runInWindow()} title="kill and rerun the command">restart</button>
              <button onClick={() => void runOutside()} title="reopen in external window">open outside</button>
              <button
                className={logsOpen ? 'preview-output__log-toggle preview-output__log-toggle--active' : 'preview-output__log-toggle'}
                aria-expanded={logsOpen}
                onClick={() => setLogsOpen((open) => !open)}
              >
                logs
              </button>
              <button onClick={stopPreview} title="stop the command and return to setup">stop</button>
            </div>
          </header>
          {processFailed ? (
            <div className="preview-error" role="alert">
              <header>
                <strong>command failed</strong>
                <span>exit code {exitCode}</span>
              </header>
              <pre className="preview-error__log" aria-label="command error output">
                {ansiToText(logs.join('')).trimEnd() || `$ ${runCommand}\n(no output captured)`}
              </pre>
              <footer>
                <button onClick={() => void runInWindow()}>retry</button>
                <button onClick={stopPreview}>back to setup</button>
              </footer>
            </div>
          ) : showIframe ? (
            <iframe
              key={frameKey}
              className="preview-iframe"
              title="project preview"
              src={runUrl}
              sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            />
          ) : sessionId ? (
            <PreviewTerminal key={sessionId} host={host} sessionId={sessionId} />
          ) : (
            <pre className="preview-terminal-frame" aria-label="interactive preview terminal">
              {`$ ${runCommand}\n`}
            </pre>
          )}
          {logsOpen && (
            <aside className="preview-log-drawer" aria-label="preview logs">
              <header>
                <div>
                  <strong>logs</strong>
                  <span>{runCommand}</span>
                </div>
                <button onClick={() => setLogsOpen(false)}>close</button>
              </header>
              <pre ref={logDrawerRef}>
                {ansiToText(logs.join('')) || `$ ${runCommand}\nwaiting for preview output...\n`}
              </pre>
            </aside>
          )}
        </section>
      </div>
    );
  }

  if (status === 'external' && mode === 'external') {
    const isExternalBrowserish = runUrlIsWebish && runKind !== 'desktop';
    const exited = exitCode !== null;
    const failed = exited && exitCode !== 0;
    /* "embed instead" switches an external run into the in-panel view. only
       offer it when the frozen run is actually embeddable — native runtimes
       (tauri/electron) ship their own OS window and were refused embedding at
       setup time, so offering it here would re-trigger the exact thing the
       setup gate (canRunInWindow) blocks. mirrors that gate against currentRun. */
    const runEmbeddable = !currentRun?.explicitNative && (
      runKind === 'cli'
      || runKind === 'test'
      || runKind === 'site'
      || runKind === 'game'
      || (runKind === 'desktop' && runUrlIsWebish)
    );
    const statusLabel = failed
      ? `process exited ${exitCode}`
      : exited
      ? 'process exited'
      : isExternalBrowserish ? 'opened externally' : 'running externally';
    return (
      <div className="preview-surface preview-surface--external">
        {headerBar}
        <section className="preview-output preview-output--fullscreen preview-output--external">
          <header>
            <strong className={failed ? 'preview-output__status preview-output__status--failed' : 'preview-output__status'}>{statusLabel}</strong>
            <span>{runUrl || runCommand}</span>
            <div className="preview-output__controls">
              <button onClick={() => void host.ui.openExternal(runUrl || '').catch(() => {})} disabled={!isExternalBrowserish} title="reopen the url in your browser">open url</button>
              <button onClick={() => { navigator.clipboard?.writeText(ansiToText(logs.join('')) || runCommand).then(() => host.ui.notify('success', 'logs copied to clipboard')).catch(() => {}); }} title="copy logs">copy logs</button>
              <button onClick={() => void runOutside()} title="kill and rerun">restart</button>
              {runEmbeddable && (
                <button onClick={() => void runInWindow()} title="switch to embedded mode">embed instead</button>
              )}
              <button onClick={stopPreview} title="stop and return to setup">stop</button>
            </div>
          </header>
          <pre
            ref={logPaneRef}
            className="preview-log-pane"
            aria-label="preview logs"
            role="log"
            onScroll={(event) => {
              const target = event.currentTarget;
              const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
              stickToBottomRef.current = distanceFromBottom < 24;
            }}
          >
            {ansiToText(logs.join('')) || `$ ${runCommand}\nwaiting for preview output...\n`}
          </pre>
        </section>
      </div>
    );
  }

  return (
    <div className="preview-surface">
      {headerBar}
      <section className="preview-setup">
        <header className="preview-setup__head">
          <div className="preview-setup__title">
            <strong>{runtime?.label ?? 'detecting project…'}</strong>
            <small>{runtime?.hint ?? 'reading manifest from project root'}</small>
          </div>
          {runtime?.source && runtime.source !== 'fallback' && (
            <span className="preview-setup__source">via {runtime.source}</span>
          )}
        </header>

        <div
          className={`preview-setup__body ${hasScripts ? 'preview-setup__body--resizable' : 'preview-setup__body--single'}`}
          style={hasScripts ? ({ '--preview-scripts-width': `${scriptsWidth}%` } as React.CSSProperties) : undefined}
        >
          {hasScripts && (
            <aside className="preview-scripts" aria-label="detected commands">
              <header className="preview-scripts__head">
                <strong>scripts</strong>
                <small>{scripts.length}</small>
              </header>
              {runtimes.length > 1 && (
                <div className="preview-runtime-list" role="listbox" aria-label="detected runtimes">
                  {runtimes.map((item) => {
                    const key = runtimeKey(item);
                    const active = runtime ? runtimeKey(runtime) === key : false;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={active ? 'preview-runtime preview-runtime--active' : 'preview-runtime'}
                        role="option"
                        aria-selected={active}
                        onClick={() => pickRuntime(item)}
                      >
                        <span>{item.label}</span>
                        <small>{item.source}</small>
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="preview-scripts__list" role="radiogroup">
                {scripts.map((script) => (
                  <button
                    key={script.name}
                    type="button"
                    className={`preview-script ${selectedScript === script.name ? 'preview-script--active' : ''}`}
                    role="radio"
                    aria-checked={selectedScript === script.name}
                    onClick={() => pickScript(script)}
                  >
                    <span className="preview-script__name">{script.name}</span>
                    <code className="preview-script__cmd">{script.command}</code>
                  </button>
                ))}
              </div>
            </aside>
          )}
          {hasScripts && (
            <ResizeHandle axis="x" label="resize preview scripts and command form" onDrag={onScriptsResize} />
          )}

          <div className="preview-form">
            <label className="preview-input">
              <span>command</span>
              <input
                value={command}
                placeholder="command to run"
                spellCheck={false}
                onChange={(event) => changeCommand(event.target.value)}
              />
            </label>

            <label className="preview-input">
              <span>url <em>optional</em></span>
              <input
                value={url}
                placeholder="http://localhost:3000"
                spellCheck={false}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>

            <div className={`preview-cta ${canRunInWindow ? '' : 'preview-cta--external-only'}`}>
              {canRunInWindow ? (
                <>
                  <button
                    type="button"
                    className="preview-cta__primary"
                    onClick={() => void runInWindow()}
                    disabled={!command.trim()}
                  >
                    <span className="preview-cta__glyph" aria-hidden="true">▶</span>
                    run in window
                  </button>
                  <button
                    type="button"
                    className="preview-cta__secondary"
                    onClick={() => void runOutside()}
                    disabled={!command.trim()}
                  >
                    open externally
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="preview-cta__primary preview-cta__primary--external"
                  onClick={() => void runOutside()}
                  disabled={!command.trim()}
                  title={runInWindowReason || undefined}
                >
                  <span className="preview-cta__glyph" aria-hidden="true">↗</span>
                  open externally
                </button>
              )}
            </div>

            <p className="preview-form__hint">
              {runInWindowReason
                ? `${runInWindowReason}.`
                : `detection inferred from ${runtime?.source ?? 'project files'}. you (or the agent) can edit the command at any time.`}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
