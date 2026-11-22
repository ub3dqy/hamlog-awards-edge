(() => {
  'use strict';

  const origin = 'https://hamlog.online';
  const access = {permissions: ['downloads'], origins: [origin + '/*']};
  const messageType = 'hamlog-issued-download';
  const operationLock = 'hamlog-awards-operation';
  const maxPdfBytes = 24 * 1024 * 1024;
  const maxPartBytes = 96 * 1024 * 1024;
  const maxPartFiles = 100;

  async function encode(blob) {
    if (typeof FileReader === 'function') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = [];
    // A multiple of three preserves base64 boundaries without padding each chunk.
    const chunkSize = 24_576;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))));
    }
    return parts.join('');
  }

  function decode(data) {
    if (typeof data !== 'string' || data.length > 4 * Math.ceil(maxPdfBytes / 3)) {
      throw new Error('Invalid certificate size');
    }
    const text = atob(data);
    if (!text.startsWith('%PDF-') || text.length > maxPdfBytes) throw new Error('Invalid certificate');
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return new Blob([bytes], {type: 'application/pdf'});
  }

  async function key(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function send(action, details = {}) {
    const api = globalThis.browser ?? globalThis.chrome;
    const reply = await api.runtime.sendMessage({type: messageType, action, ...details});
    if (!reply?.ok) {
      const error = new Error('Could not update download progress');
      error.userMessage = reply?.error || 'Не удалось сохранить ход скачивания. Нажмите «Скачать выданные», чтобы продолжить.';
      throw error;
    }
    return reply.value;
  }

  function connect(token) {
    const request = (action, details) => send(action, {...details, token});
    async function settle(result, partNumber) {
      while (result === 'pending') {
        await new Promise(resolve => setTimeout(resolve, 750));
        result = await request('poll', {partNumber});
      }
      return result;
    }
    return {
      async load(keys, {complete = true} = {}) {
        await settle(await request('poll'));
        return request('load', {keys, complete});
      },
      async file(key) {
        const entry = await request('file', {key});
        return {filename: entry.filename, blob: decode(entry.data)};
      },
      async stage(key, file) {
        await request('stage', {key, filename: file.filename, data: await encode(file.blob)});
      },
      async save(part, url) {
        return await settle(await request('save', {part, url}), part.number) === 'complete';
      },
      deactivate: () => request('deactivate')
    };
  }

  async function runExclusive(run, wait, onDisconnect) {
    const api = globalThis.browser ?? globalThis.chrome;
    if (typeof globalThis.cloneInto !== 'function') {
      return navigator.locks.request(operationLock, {ifAvailable: !wait}, run);
    }

    // A Firefox page cannot await a Web Locks callback from the extension sandbox.
    const port = api.runtime.connect({name: wait ? operationLock + '-wait' : operationLock});
    const keepAlive = setInterval(() => port.postMessage(true), 15_000);
    try {
      const granted = await new Promise((resolve, reject) => {
        port.onMessage.addListener(resolve);
        port.onDisconnect.addListener(() => {
          clearInterval(keepAlive);
          onDisconnect();
          reject(new Error('Download operation disconnected'));
        });
      });
      return await run(granted);
    } finally {
      clearInterval(keepAlive);
      port.disconnect();
    }
  }

  globalThis.hamlogIssuedProgress = Object.freeze({
    access, messageType, maxPartBytes, maxPartFiles, decode, encode, key, send, connect, origin,
    operationLock, runExclusive
  });
})();
