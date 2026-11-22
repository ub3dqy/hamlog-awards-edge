(() => {
  'use strict';

  const api = globalThis.browser ?? globalThis.chrome;
  const {access, messageType, origin, maxPartBytes, maxPartFiles, encode, decode, operationLock} = globalThis.hamlogIssuedProgress;
  const protocol = new URL(origin).protocol;
  const awardsPage = origin + '/account/awards.php';
  const activeKey = 'hamlog-issued-task';
  const alarmName = 'hamlog-issued-recovery';
  const scripts = ['callsign.js', 'site-adapter.js', 'certificate-archive.js', 'issued-progress.js', 'runner.js'];
  let database;
  let previous = Promise.resolve();
  let workingPort;
  const waitingPorts = new Set();

  function queue(run) {
    const result = previous.then(run);
    previous = result.catch(() => {});
    return result;
  }

  function openDatabase() {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('hamlog-issued-downloads', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('progress', {keyPath: 'callsign'});
        db.createObjectStore('files', {keyPath: ['callsign', 'key']}).createIndex('callsign', 'callsign');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    }).catch(error => {
      database = undefined;
      throw error;
    });
    return database;
  }

  async function transaction(stores, mode, run) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode, mode === 'readwrite' ? {durability: 'strict'} : undefined);
      let value;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(tx.error ?? new Error('Download progress transaction aborted'));
      run(tx, result => { value = result; });
    });
  }

  function read(store, request) {
    return transaction([store], 'readonly', (tx, result) => {
      const lookup = request(tx.objectStore(store));
      lookup.onsuccess = () => result(lookup.result);
    });
  }

  async function progressFor(callsign) {
    return await read('progress', store => store.get(callsign)) ?? {callsign, parts: []};
  }

  function listFiles(callsign) {
    return read('files', store => store.index('callsign').getAll(callsign));
  }

  function writeProgress(progress, remove = []) {
    return transaction(['progress', 'files'], 'readwrite', tx => {
      tx.objectStore('progress').put(progress);
      const files = tx.objectStore('files');
      for (const key of remove) files.delete([progress.callsign, key]);
    });
  }

  async function activeTask() {
    return (await api.storage.local.get(activeKey))[activeKey];
  }

  function setTask(task) {
    return api.storage.local.set({[activeKey]: task});
  }

  function isHamlog(value) {
    try {
      const url = new URL(value);
      return url.protocol === protocol && url.origin === origin && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  function isHamlogTab(tab) {
    return tab && !tab.incognito && (isHamlog(tab.url) || isHamlog(tab.pendingUrl));
  }

  function validKey(value) {
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  }

  function validFilename(value, type) {
    return typeof value === 'string' && value.length <= 180 && !/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value) &&
      !value.startsWith('.') && value.toLowerCase().endsWith('.' + type);
  }

  async function reconcile(progress) {
    const flight = progress.flight;
    if (!flight) return 'idle';
    const items = await api.downloads.search({url: flight.url});
    const own = items.filter(item => item.url === flight.url && !item.incognito);
    const complete = own.some(item => item.state === 'complete');
    if (!complete && own.some(item => item.state === 'in_progress')) return 'pending';

    delete progress.flight;
    if (complete) progress.parts.push(flight.part);
    await writeProgress(progress, complete ? flight.part.keys : []);
    if (flight.fromBackground) URL.revokeObjectURL(flight.url);
    return complete ? 'complete' : 'interrupted';
  }

  async function load(progress, keys, complete = true) {
    if (!Array.isArray(keys) || !keys.every(validKey) || typeof complete !== 'boolean') {
      throw new Error('Invalid list of certificates');
    }
    if (progress.flight) throw new Error('Unfinished archive');
    const available = new Set(keys);
    const files = await listFiles(progress.callsign);
    if (complete) {
      const discarded = files.filter(file => !available.has(file.key));
      if (discarded.length) await writeProgress(progress, discarded.map(file => file.key));
    }
    return {
      parts: progress.parts,
      staged: files.filter(file => available.has(file.key)).map(file => file.key)
    };
  }

  async function stage(callsign, {key, filename, data}) {
    if (!validKey(key) || !validFilename(filename, 'pdf')) throw new Error('Invalid certificate');
    const files = await listFiles(callsign);
    if (files.some(file => file.key === key)) return;
    const blob = decode(data);
    const size = files.reduce((total, file) => total + file.blob.size, 0);
    // One extra PDF can be held over for the next archive.
    if (files.length >= maxPartFiles + 1 || size > maxPartBytes) {
      throw new Error('Download buffer is full');
    }
    await transaction(['files'], 'readwrite', tx => tx.objectStore('files').put({callsign, key, filename, blob}));
  }

  async function readFile(callsign, key) {
    if (!validKey(key)) throw new Error('Invalid certificate key');
    const file = await read('files', store => store.get([callsign, key]));
    if (!file) throw new Error('Certificate is missing from the buffer');
    return {filename: file.filename, data: await encode(file.blob)};
  }

  async function save(progress, {part, url}) {
    if (progress.flight || !Array.isArray(part?.keys) || part.keys.length < 1 || part.keys.length > maxPartFiles ||
        !part.keys.every(validKey) || new Set(part.keys).size !== part.keys.length ||
        part.number !== progress.parts.length + 1 || typeof url !== 'string' ||
        !url.startsWith('blob:' + origin + '/') || !/^[a-f0-9-]{36}$/i.test(url.slice(('blob:' + origin + '/').length))) {
      throw new Error('Invalid archive request');
    }
    const type = part.keys.length === 1 ? 'PDF' : 'ZIP';
    if (part.type !== type || !validFilename(part.filename, type.toLowerCase())) throw new Error('Invalid archive name');
    const staged = new Map((await listFiles(progress.callsign)).map(file => [file.key, file]));
    const files = part.keys.map(key => staged.get(key));
    if (files.some(file => !file) || files.reduce((size, file) => size + file.blob.size, 0) > maxPartBytes) {
      throw new Error('Incomplete archive');
    }

    // Firefox cannot download a page-origin blob from an extension. Its background page can create its own.
    const fromBackground = typeof URL.createObjectURL === 'function';
    let source = url;
    if (fromBackground) {
      const blob = type === 'PDF' ? files[0].blob : await globalThis.hamlogCertificateArchive.create(files);
      source = URL.createObjectURL(blob);
    }
    progress.flight = {url: source, fromBackground, part};
    try {
      // Record the exact URL before starting. Download IDs can be reused after a Firefox restart.
      await writeProgress(progress);
    } catch (error) {
      if (fromBackground) URL.revokeObjectURL(source);
      throw error;
    }
    // A declined or interrupted save leaves the prepared PDFs available for another attempt.
    await api.downloads.download({url: source, filename: part.filename, conflictAction: 'uniquify'}).catch(() => {});
    return reconcile(progress);
  }

  async function inject(task) {
    const target = {tabId: task.tabId};
    const [injection] = await api.scripting.executeScript({target, files: scripts});
    if (injection?.error) throw new Error('Could not load the HAMLOG panel');
    const [execution] = await api.scripting.executeScript({
      target, args: [task.callsign, task.token],
      func: (callsign, token) => {
        const job = globalThis.hamlogAwards?.run('download', callsign, undefined, token);
        if (!job?.ok) return 'unavailable';
        return job.busy && !job.resumable ? 'busy' : 'started';
      }
    });
    if (execution?.result === 'busy') {
      await api.alarms.create(alarmName, {delayInMinutes: 0.5});
    } else if (execution?.result !== 'started') {
      throw new Error('HAMLOG panel unavailable');
    }
  }

  async function findTab(id) {
    try {
      return await api.tabs.get(id);
    } catch {
      return null;
    }
  }

  async function launch(tabId) {
    const {callsign: selected} = await api.storage.local.get('callsign');
    const callsign = globalThis.hamlogCallsign.normalize(selected);
    const tab = await findTab(tabId);
    if (!callsign || !isHamlogTab(tab) || !await api.permissions.contains(access)) throw new Error('Invalid download context');
    const current = await activeTask();
    if (current?.active) {
      if (current.callsign !== callsign) {
        const error = new Error('Another callsign has an active download');
        error.userMessage = 'Сначала остановите скачивание для предыдущего позывного во вкладке HAMLOG.';
        throw error;
      }
      const owner = await findTab(current.tabId);
      if (isHamlogTab(owner) && !owner.discarded) {
        if (owner.id !== tabId) {
          await api.tabs.update(owner.id, {active: true});
          await api.windows.update(owner.windowId, {focused: true}).catch(() => {});
        }
        await inject(current);
        return;
      }
    }
    const task = {callsign, tabId, token: crypto.randomUUID(), active: true};
    await setTask(task);
    try {
      await inject(task);
    } catch (error) {
      await api.alarms.create(alarmName, {delayInMinutes: 0.5});
      throw error;
    }
  }

  async function resume({updatedTab, withoutWindow, retry = false} = {}) {
    const current = await activeTask();
    if (!current?.active || !await api.permissions.contains(access)) return;

    let tab = await findTab(current.tabId);
    if (updatedTab != null && updatedTab !== current.tabId && isHamlogTab(tab)) return;
    let task = current;
    if (!isHamlogTab(tab) || tab.windowId === withoutWindow) {
      const tabs = await api.tabs.query({windowType: 'normal'});
      const candidates = tabs.filter(item => !item.incognito && item.windowId !== withoutWindow);
      if (!candidates.length) return;
      tab = candidates.find(item => !item.discarded && isHamlogTab(item));
      const opened = !tab;
      if (!tab) {
        const selected = candidates.find(item => item.active);
        if (!selected) {
          await api.alarms.create(alarmName, {delayInMinutes: 0.5});
          return;
        }
        tab = await api.tabs.create({windowId: selected.windowId, active: false, url: awardsPage});
      }
      task = {...current, tabId: tab.id, token: crypto.randomUUID(), opened};
      await setTask(task);
    }
    if (tab.discarded || (retry && task.opened)) {
      try {
        await inject(task);
        return;
      } catch {
        await api.tabs.reload(tab.id);
        await api.alarms.create(alarmName, {delayInMinutes: 0.5});
        return;
      }
    }
    if (tab.status !== 'complete') {
      await api.alarms.create(alarmName, {delayInMinutes: 0.5});
      return;
    }
    try {
      await inject(task);
    } catch {
      await api.alarms.create(alarmName, {delayInMinutes: 0.5});
    }
  }

  async function dispatch(message, sender) {
    if (message.action === 'launch' && sender.url === api.runtime.getURL('popup.html')) return launch(message.tabId);
    const task = await activeTask();
    if (!task || message.token !== task.token || sender.tab?.id !== task.tabId ||
        sender.tab.incognito || sender.frameId !== 0 || !isHamlog(sender.url) ||
        !await api.permissions.contains(access)) {
      throw new Error('Invalid download request');
    }
    if (message.action === 'deactivate') {
      await setTask({...task, active: false});
      return;
    }
    const progress = await progressFor(task.callsign);
    switch (message.action) {
      case 'poll': {
        const result = await reconcile(progress);
        if (message.partNumber === undefined || result === 'pending') return result;
        return progress.parts.length >= message.partNumber ? 'complete' : 'interrupted';
      }
      case 'load': return load(progress, message.keys, message.complete);
      case 'stage': return stage(task.callsign, message);
      case 'file': return readFile(task.callsign, message.key);
      case 'save': return save(progress, message);
      default: throw new Error('Unknown download request');
    }
  }

  function downloadChanged(delta) {
    if (delta.state?.current !== 'complete') return;
    void queue(async () => {
      const task = await activeTask();
      if (task) await reconcile(await progressFor(task.callsign));
    }).catch(() => {});
  }

  function watchDownloads() {
    if (api.downloads && !api.downloads.onChanged.hasListener(downloadChanged)) {
      api.downloads.onChanged.addListener(downloadChanged);
    }
  }

  function grantPort() {
    if (workingPort) return;
    for (const port of waitingPorts) {
      waitingPorts.delete(port);
      try {
        port.postMessage(true);
        workingPort = port;
        return;
      } catch {
        // A tab may have closed while it waited.
      }
    }
  }

  api.runtime.onConnect.addListener(port => {
    const wait = port.name === operationLock + '-wait';
    if (port.name !== operationLock && !wait) return;
    if (port.sender?.id !== api.runtime.id || port.sender.frameId !== 0 || !isHamlog(port.sender.url)) {
      port.disconnect();
      return;
    }
    if (workingPort && !wait) {
      port.postMessage(false);
      return;
    }
    port.onMessage.addListener(() => {});
    port.onDisconnect.addListener(() => {
      waitingPorts.delete(port);
      if (workingPort === port) workingPort = undefined;
      grantPort();
    });
    waitingPorts.add(port);
    grantPort();
  });

  api.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== messageType) return;
    void queue(() => dispatch(message, sender)).then(
      value => respond({ok: true, value}),
      error => respond({ok: false, error: error?.userMessage})
    );
    return true;
  });
  api.runtime.onStartup.addListener(() => { void queue(() => resume()).catch(() => {}); });
  api.runtime.onInstalled.addListener(() => { void queue(() => resume()).catch(() => {}); });
  api.windows.onCreated.addListener(() => { void queue(() => resume()).catch(() => {}); });
  api.tabs.onUpdated.addListener((id, change, tab) => {
    if (change.status === 'complete' && isHamlogTab(tab)) {
      void queue(() => resume({updatedTab: id})).catch(() => {});
    }
  });
  api.tabs.onRemoved.addListener((id, info) => {
    void queue(async () => {
      const task = await activeTask();
      if (task?.tabId !== id) return;
      // Firefox sends this before it selects a remaining tab in the window.
      await new Promise(resolve => setTimeout(resolve, 150));
      await resume({withoutWindow: info.isWindowClosing ? info.windowId : undefined});
    }).catch(() => {});
  });
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === alarmName) void queue(() => resume({retry: true})).catch(() => {});
  });
  api.permissions.onAdded.addListener(watchDownloads);
  watchDownloads();
})();
