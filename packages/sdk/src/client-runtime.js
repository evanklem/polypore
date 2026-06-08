/* polypore plugin SDK runtime — injected into every plugin iframe.
   exposes window.polypore: a typed RPC client over postMessage, implementing
   the envelope format from §21 of the master plan. self-contained IIFE; the
   iframe has null origin under sandbox="allow-scripts" so this file must not
   import anything. */
(function installPolyporeRuntime() {
  if (typeof window === 'undefined') return;
  if (window.polypore) return;

  var pending = new Map();
  var topicListeners = new Map();
  var nextId = 1;
  /* srcdoc plugins get the id injected as window.POLYPORE_PLUGIN_ID; URL-mode
     plugins (served from a file:// or custom-protocol URL) instead pass it as
     a query parameter so the host can correlate postMessage envelopes. */
  var _urlParams = (typeof URLSearchParams !== 'undefined'
    && typeof location !== 'undefined' && location.search)
    ? new URLSearchParams(location.search) : null;
  var manifestId = (window.POLYPORE_PLUGIN_ID
    || (_urlParams && _urlParams.get('pluginId'))
    || 'unknown');
  var ready = false;
  var readyWaiters = [];

  function send(envelope) {
    window.parent.postMessage({ __polypore: true, pluginId: manifestId, envelope: envelope }, '*');
  }

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending.set(id, { resolve: resolve, reject: reject });
      send({ kind: 'request', id: id, method: method, params: params == null ? {} : params });
    });
  }

  function on(topic, fn) {
    var list = topicListeners.get(topic);
    if (!list) {
      list = [];
      topicListeners.set(topic, list);
      send({ kind: 'request', id: nextId++, method: 'host.subscribe', params: { topic: topic } });
    }
    list.push(fn);
    return function unsubscribe() {
      var current = topicListeners.get(topic);
      if (!current) return;
      var idx = current.indexOf(fn);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) {
        topicListeners.delete(topic);
        send({ kind: 'request', id: nextId++, method: 'host.unsubscribe', params: { topic: topic } });
      }
    };
  }

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.__polypore !== true) return;
    if (data.pluginId && data.pluginId !== manifestId) return;
    var env = data.envelope;
    if (!env) return;
    if (env.kind === 'response') {
      var slot = pending.get(env.id);
      if (!slot) return;
      pending.delete(env.id);
      if (env.ok === true) slot.resolve(env.result);
      else slot.reject(Object.assign(new Error(env.error.message), { code: env.error.code, data: env.error.data }));
      return;
    }
    if (env.kind === 'event') {
      var list = topicListeners.get(env.topic);
      if (!list) return;
      list.slice().forEach(function (fn) { try { fn(env.payload); } catch (e) { /* swallow per plugin */ } });
      return;
    }
  });

  function waitForReady() {
    if (ready) return Promise.resolve();
    return new Promise(function (resolve) { readyWaiters.push(resolve); });
  }

  /* api surface — typed mirror of §4.3 PolyporeHost. each group is a thin
     wrapper around request(). this is intentionally not a class so the
     iframe can JSON.stringify without circular issues. */
  var api = {
    panel: { id: manifestId, instanceId: window.POLYPORE_INSTANCE_ID || (_urlParams && _urlParams.get('instanceId')) || null },
    ready: waitForReady,
    raw: request,
    registerManifest: function (manifest) { return request('manifest.register', { manifest: manifest }); },
    state: {
      get: function (key) { return request('state.get', { key: key }); },
      subscribe: function (key, fn) { return on('state:' + key, fn); },
    },
    editor: {
      tree: function () { return request('editor.tree', {}); },
      open: function (path, opts) { return request('editor.open', { path: path, opts: opts }); },
      onOpen: function (fn) { return on('editor:opened', fn); },
      read: function (path) { return request('editor.read', { path: path }); },
      applyEdit: function (path, edits) { return request('editor.applyEdit', { path: path, edits: edits }); },
      onChange: function (path, fn) { return on('editor:' + path, fn); },
      /* decorations / cursor / selection */
      setDecorations: function (path, decorations) {
        return request('editor.setDecorations', { path: path, decorations: decorations, pluginId: manifestId });
      },
      cursor: function (path) { return request('editor.cursor', { path: path }); },
      selection: function (path) { return request('editor.selection', { path: path }); },
      revealLine: function (path, line) { return request('editor.revealLine', { path: path, line: line }); },
      language: function (path) { return request('editor.language', { path: path }); },
      onDidChangeCursor: function (fn) { return on('state:editorCursor', fn); },
      onDidChangeSelection: function (fn) { return on('state:editorSelection', fn); },
      onDidSave: function (path, fn) { return on('editor:saved:' + path, fn); },
    },
    knowledge: {
      bases: function () { return request('knowledge.bases', {}); },
      openFolder: function () { return request('knowledge.openFolder', {}); },
      createBase: function (input) { return request('knowledge.createBase', input); },
      suggestBaseLocation: function (input) { return request('knowledge.suggestBaseLocation', input); },
      pickBaseLocation: function () { return request('knowledge.pickBaseLocation', {}); },
      setBaseScope: function (id, scope) { return request('knowledge.setBaseScope', { id: id, scope: scope }); },
      renameBase: function (id, name) { return request('knowledge.renameBase', { id: id, name: name }); },
      deleteBase: function (id) { return request('knowledge.deleteBase', { id: id }); },
      createFolder: function (path, baseId) { return request('knowledge.createFolder', { path: path, baseId: baseId }); },
      renameFolder: function (from, to, baseId) { return request('knowledge.renameFolder', { from: from, to: to, baseId: baseId }); },
      deleteFolder: function (path, baseId) { return request('knowledge.deleteFolder', { path: path, baseId: baseId }); },
      list: function (baseId) { return request('knowledge.list', { baseId: baseId }); },
      read: function (path, baseId) { return request('knowledge.read', { path: path, baseId: baseId }); },
      write: function (path, content, baseId) { return request('knowledge.write', { path: path, content: content, baseId: baseId }); },
      recordAdr: function (input) { return request('adr.record', input); },
      onChange: function (fn) { return on('knowledge:changed', fn); },
    },
    tasks: {
      list: function () { return request('tasks.list', {}); },
      add: function (task) { return request('tasks.add', task); },
      update: function (id, patch) { return request('tasks.update', { id: id, patch: patch }); },
      onChange: function (fn) { return on('tasks:changed', fn); },
    },
    diagnostics: {
      list: function (filter) { return request('diagnostics.list', filter || {}); },
      document: function (path, content) { return request('diagnostics.document', { path: path, content: content }); },
      deepScan: function () { return request('diagnostics.deepScan', {}); },
      onChange: function (fn) { return on('diagnostics:changed', fn); },
    },
    verify: {
      runs: function () { return request('verify.runs', {}); },
      run: function (id) { return request('verify.run', { id: id }); },
      onChange: function (fn) { return on('verify:changed', fn); },
    },
    iterate: {
      run: function (params) { return request('iterate.run', params || {}); },
    },
    chat: {
      sessions: function () { return request('chat.sessions', {}); },
      history: function (sessionId) { return request('chat.history', { sessionId: sessionId }); },
      send: function (sessionId, text, opts) {
        return request('chat.send', { sessionId: sessionId, text: text, worktreeId: opts && opts.worktreeId });
      },
      /* stream — same as send but calls onChunk for each agent message that
         arrives for this session while the subscription is active.
         returns { message, agentQueued, unsubscribe } */
      stream: function (sessionId, text, opts) {
        var onChunk = opts && typeof opts.onChunk === 'function' ? opts.onChunk : null;
        var unsub = onChunk ? on('chat:message', function (payload) {
          if (payload && payload.sessionId === sessionId && payload.message && payload.message.by === 'agent') {
            try { onChunk(payload.message); } catch (e) {}
          }
        }) : function () {};
        return request('chat.send', {
          sessionId: sessionId,
          text: text,
          worktreeId: opts && opts.worktreeId,
        }).then(function (result) {
          return Object.assign({}, result, { unsubscribe: unsub });
        }).catch(function (err) {
          unsub();
          throw err;
        });
      },
      interrupt: function (sessionId) { return request('chat.interrupt', { sessionId: sessionId }); },
      context: {
        list: function (sessionId) { return request('chat.context.list', { sessionId: sessionId }); },
        add: function (sessionId, path) { return request('chat.context.add', { sessionId: sessionId, path: path }); },
        remove: function (sessionId, path) { return request('chat.context.remove', { sessionId: sessionId, path: path }); },
      },
      onMessage: function (fn) { return on('chat:message', fn); },
      onTool: function (sessionId, fn) {
        return on('agent:tool-call', function (event) {
          if (event && event.payload && event.payload.sessionId === sessionId) try { fn(event); } catch (e) {}
        });
      },
    },
    history: {
      events: function (filter) { return request('history.events', filter || {}); },
      diff: function (requestOrMode, file) {
        if (requestOrMode && typeof requestOrMode === 'object') return request('history.diff', requestOrMode);
        return request('history.diff', { mode: requestOrMode || 'working', file: file });
      },
      fork: function (eventId) { return request('history.fork', { eventId: eventId }); },
      revert: function (paramsOrEventId, files) {
        if (paramsOrEventId && typeof paramsOrEventId === 'object') return request('history.revert', paramsOrEventId);
        return request('history.revert', { eventId: paramsOrEventId, files: files });
      },
      onEvent: function (fn) { return on('history:event', fn); },
    },
    worktrees: {
      list: function () { return request('worktrees.list', {}); },
      create: function (params) { return request('worktrees.create', params || {}); },
    },
    snapshots: {
      take: function (params) { return request('snapshots.take', params || {}); },
      signalTurnEnd: function (params) { return request('snapshots.signalTurnEnd', params || {}); },
    },
    preview: {
      list: function () { return request('preview.list', {}); },
      register: function (target) { return request('preview.register', target); },
      refresh: function (id) { return request('preview.refresh', { id: id }); },
    },
    terminal: {
      spawn: function (command, size) { return request('terminal.spawn', Object.assign({ command: command }, size || {})); },
      stop: function (id) { return request('terminal.stop', { id: id }); },
      write: function (id, data) { return request('terminal.write', { id: id, data: data }); },
      resize: function (id, cols, rows) { return request('terminal.resize', { id: id, cols: cols, rows: rows }); },
      list: function () { return request('terminal.list', {}); },
      read: function (id) { return request('terminal.read', { id: id }); },
      onEvent: function (fn) { return on('terminal:event', fn); },
      onOutput: function (id, fn) {
        return on('terminal:output:' + id, function (payload) { try { fn(payload && payload.chunk); } catch (e) {} });
      },
      onExit: function (id, fn) { return on('terminal:exit:' + id, fn); },
    },
    panels: {
      open: function (id, opts) { return request('panel.open', { id: id, area: opts && opts.area }); },
      close: function (instanceId) { return request('panel.close', { instanceId: instanceId }); },
      list: function () { return request('panel.list', {}); },
    },
    workspace: {
      activePanel: function () { return request('workspace.activePanel', {}); },
      openPanel: function (id, opts) { return request('panel.open', { id: id, area: opts && opts.area }); },
      closePanel: function (instanceId) { return request('panel.close', { instanceId: instanceId }); },
    },
    secrets: {
      list: function (scope) { return request('secrets.list', { scope: scope }); },
      has: function (id, scope) { return request('secrets.has', { id: id, scope: scope }); },
      use: function (idOrRequest, req) {
        if (idOrRequest && typeof idOrRequest === 'object' && idOrRequest.request) {
          return request('secrets.use', idOrRequest);
        }
        return request('secrets.use', { id: idOrRequest, request: req });
      },
      reveal: function (id, scope) { return request('secrets.reveal', scope ? { id: id, scope: scope } : { id: id }); },
      set: function (input) { return request('secrets.set', input); },
      delete: function (id, scope) { return request('secrets.delete', scope ? { id: id, scope: scope } : { id: id }); },
    },
    debug: {
      probe: function (params) { return request('debug.probe', params); },
      start: function (params) { return request('debug.start', params); },
      setBreakpoints: function (params) { return request('debug.setBreakpoints', params); },
      addBreakpoint: function (params) { return request('debug.addBreakpoint', params); },
      removeBreakpoint: function (params) { return request('debug.removeBreakpoint', params); },
      continue: function (params) { return request('debug.continue', params || {}); },
      stepOver: function (params) { return request('debug.stepOver', params || {}); },
      stepIn: function (params) { return request('debug.stepIn', params || {}); },
      stepOut: function (params) { return request('debug.stepOut', params || {}); },
      pause: function (params) { return request('debug.pause', params || {}); },
      stackTrace: function (params) { return request('debug.stackTrace', params || {}); },
      scopes: function (params) { return request('debug.scopes', params); },
      variables: function (params) { return request('debug.variables', params); },
      evaluate: function (params) { return request('debug.evaluate', params); },
      setTrust: function (trust) { return request('debug.setTrust', { trust: trust }); },
      capture: {
        screenshot: function (params) { return request('debug.capture.screenshot', params || {}); },
        console: function (params) { return request('debug.capture.console', params || {}); },
        dom: function (params) { return request('debug.capture.dom', params || {}); },
        network: function () { return request('debug.capture.network', {}); },
      },
      capabilities: function () { return request('debug.capabilities', {}); },
      navigate: function (url) { return request('debug.navigate', { url: url }); },
      click: function (selector) { return request('debug.click', { selector: selector }); },
      fill: function (selector, text) { return request('debug.fill', { selector: selector, text: text }); },
      login: function (params) { return request('debug.login', params); },
      roadblock: function (ask) { return request('debug.roadblock', { ask: ask }); },
      resolveRoadblock: function () { return request('debug.roadblock.resolve', {}); },
      rootCause: function (params) { return request('debug.rootCause', params); },
      sessions: function () { return request('debug.sessions', {}); },
      select: function (id) { return request('debug.select', { id: id }); },
      state: function () { return request('debug.state', {}); },
      stop: function () { return request('debug.stop', {}); },
      onChange: function (fn) { return on('state:debug', fn); },
    },
    plugins: {
      list: function () { return request('plugins.list', {}); },
      install: function (plugin) { return request('plugins.install', { plugin: plugin }); },
      uninstall: function (id) { return request('plugins.uninstall', { id: id }); },
      enable: function (id) { return request('plugins.enable', { id: id }); },
      disable: function (id) { return request('plugins.disable', { id: id }); },
      toggle: function (id) { return request('plugins.toggle', { id: id }); },
    },
    mcp: {
      invoke: function (req) { return request('mcp.invoke', req || {}); },
      discover: function () { return request('mcp.discover', {}); },
      servers: {
        list: function (scope) { return request('mcp.servers.list', scope ? { scope: scope } : {}); },
        upsert: function (server) { return request('mcp.servers.upsert', server); },
        delete: function (id) { return request('mcp.servers.delete', { id: id }); },
        test: function (id) { return request('mcp.servers.test', { id: id }); },
      },
    },
    skills: {
      list: function () { return request('skills.list', {}); },
      read: function (id) { return request('skills.read', { id: id }); },
      write: function (skill) { return request('skills.write', skill); },
      delete: function (id) { return request('skills.delete', { id: id }); },
      invoke: function (id, args) { return request('skills.invoke', { id: id, args: args }); },
      publish: function (id, agents) { return request('skills.publish', { id: id, agents: agents }); },
    },
    skillsets: {
      list: function () { return request('skillsets.list', {}); },
      read: function (id) { return request('skillsets.read', { id: id }); },
      upsert: function (skillset) { return request('skillsets.upsert', skillset); },
      delete: function (id) { return request('skillsets.delete', { id: id }); },
    },
    formation: {
      upsert: function (spec) { return request('formation.upsert', spec); },
    },
    ui: {
      notify: function (level, msg) { return request('ui.notify', { level: level, msg: msg }); },
      confirm: function (msg) { return request('ui.confirm', { msg: msg }); },
      openExternal: function (url) { return request('ui.openExternal', { url: url }); },
      inputBox: function (opts) { return request('ui.inputBox', opts || {}); },
      quickPick: function (items) { return request('ui.quickPick', { items: items }); },
      statusBar: {
        add: function (text, tooltip) {
          return request('ui.statusBar.add', { text: text, tooltip: tooltip, pluginId: manifestId });
        },
        update: function (id, opts) {
          return request('ui.statusBar.update', Object.assign({ id: id }, opts || {}));
        },
        remove: function (id) { return request('ui.statusBar.remove', { id: id }); },
        onChange: function (fn) { return on('ui:statusBar-changed', fn); },
      },
      panel: {
        setTitle: function (instanceId, title) { return request('ui.panel.setTitle', { instanceId: instanceId, title: title }); },
        setBadge: function (instanceId, count) { return request('ui.panel.setBadge', { instanceId: instanceId, count: count }); },
        focus: function (instanceId) { return request('ui.panel.focus', { instanceId: instanceId }); },
      },
    },
    /* file system — create/delete/rename beyond applyEdit */
    fs: {
      write: function (path, content) { return request('fs.write', { path: path, content: content }); },
      delete: function (path) { return request('fs.delete', { path: path }); },
      rename: function (from, to) { return request('fs.rename', { from: from, to: to }); },
      mkdir: function (path) { return request('fs.mkdir', { path: path }); },
      exists: function (path) { return request('fs.exists', { path: path }); },
      stat: function (path) { return request('fs.stat', { path: path }); },
      watch: function (glob, fn) {
        return on('fs:event', function (payload) {
          if (!glob || !payload || !payload.path) { try { fn(payload); } catch (e) {} return; }
          /* minimal glob match: only supports leading '*/' and trailing '/*' */
          var g = String(glob);
          var hit = g === '*' || g === '**' || payload.path === g
            || (g.endsWith('*') && payload.path.startsWith(g.slice(0, -1)))
            || (g.startsWith('*') && payload.path.endsWith(g.slice(1)));
          if (hit) try { fn(payload); } catch (e) {}
        });
      },
    },
    /* plugin storage — scoped to this plugin's ID */
    storage: {
      get: function (key) { return request('storage.get', { pluginId: manifestId, key: key }); },
      set: function (key, value) { return request('storage.set', { pluginId: manifestId, key: key, value: value }); },
      delete: function (key) { return request('storage.delete', { pluginId: manifestId, key: key }); },
      list: function () { return request('storage.list', { pluginId: manifestId }); },
    },
    /* git — read-only by default; git.write permission required for stash */
    git: {
      status: function () { return request('git.status', {}); },
      log: function (opts) { return request('git.log', opts || {}); },
      blame: function (path) { return request('git.blame', { path: path }); },
      branches: function () { return request('git.branches', {}); },
      stash: function () { return request('git.stash', {}); },
      unstash: function () { return request('git.unstash', {}); },
      onBranchChange: function (fn) { return on('state:branch', fn); },
    },
    /* http proxy — routed through the shell; requires http.fetch permission */
    http: {
      fetch: function (opts) { return request('http.fetch', opts || {}); },
    },
    /* clipboard — requires clipboard.read / clipboard.write permissions */
    clipboard: {
      read: function () { return request('clipboard.read', {}); },
      write: function (text) { return request('clipboard.write', { text: text }); },
    },
    bus: {
      on: on,
      publish: function (topic, payload) { return request('bus.publish', { topic: topic, payload: payload }); },
    },
  };

  window.polypore = api;

  /* handshake — host listens for 'plugin.ready' and replies with an
     acknowledgement event whose payload includes the active permission set.
     plugins can use polypore.ready() to await this. */
  request('plugin.ready', { manifestId: manifestId }).then(function () {
    ready = true;
    var waiters = readyWaiters.slice();
    readyWaiters.length = 0;
    waiters.forEach(function (resolve) { resolve(); });
  }).catch(function () {
    /* host may decline; expose ready as failed by leaving ready=false. */
  });
})();
