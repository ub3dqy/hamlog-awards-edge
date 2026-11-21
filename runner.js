(() => {
  'use strict';

  const origin = 'https://hamlog.online';
  if (location.origin !== origin || globalThis.hamlogAwards) return;

  const maxPreparedFiles = 100;
  const maxPreparedBytes = 96 * 1024 * 1024;
  const maxRetainedIssuedBytes = 256 * 1024 * 1024;
  const maxRetryDelay = 30_000;
  const sessions = new Map();
  let current;
  let operation;
  let panel;

  const css = `
    :host {
      all: initial;
      position: fixed;
      inset: 12px 12px auto auto;
      width: min(440px, calc(100vw - 24px));
      z-index: 2147483647;
      color-scheme: light;
      color: #142231;
      font: 14px/1.45 system-ui, sans-serif;
    }
    :host([hidden]) { display: none !important; }
    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .panel {
      max-height: min(740px, calc(100vh - 24px));
      overflow: auto;
      background: #fff;
      border: 1px solid #c4d1dd;
      border-radius: 12px;
      padding: 16px;
      box-shadow: 0 8px 32px #14223135;
      overflow-wrap: anywhere;
    }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    h2 { margin: 0; font-size: 17px; }
    p { margin: 8px 0; }
    .detail { color: #45576a; }
    button {
      border: 1px solid #8a9dae;
      border-radius: 7px;
      padding: 5px 9px;
      background: #f4f8fb;
      color: #142231;
      font: inherit;
      cursor: pointer;
    }
    button:disabled { cursor: default; opacity: 0.65; }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid #135ea3; outline-offset: 2px; }
    progress { display: block; width: 100%; height: 11px; accent-color: #176b8c; }
    details { margin-top: 12px; border-top: 1px solid #e3ebf1; padding-top: 8px; }
    summary { font-weight: 650; cursor: pointer; }
    ul { padding-inline-start: 23px; margin: 8px 0 0; }
    li + li { margin-top: 5px; }
    a { color: #0b587d; }
    .save { display: inline-block; margin-top: 10px; font-weight: 650; }
  `;

  function element(parent, tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    parent.append(node);
    return node;
  }

  function section(parent, title) {
    const details = element(parent, 'details');
    details.hidden = true;
    const heading = element(details, 'summary');
    const list = element(details, 'ul');
    return {details, heading, list, title};
  }

  function updateSection(group) {
    const count = group.list.childElementCount;
    group.heading.textContent = `${group.title} (${count})`;
    group.details.hidden = count === 0;
  }

  function safeUrl(value) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const url = new URL(value, origin);
      return url.origin === origin && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  function addRow(group, label, url, linkText) {
    const row = element(group.list, 'li', label);
    const target = safeUrl(url);
    if (target) {
      row.append(' ');
      const link = element(row, 'a', linkText);
      link.href = target;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    }
    updateSection(group);
    return row;
  }

  function forgetIssuedParts(state) {
    if (!state) return;
    for (const {url} of state.retained.values()) URL.revokeObjectURL(url);
    for (const part of state.parts) part.row = undefined;
    state.retained.clear();
    state.bytes = 0;
    state.nextFile = undefined;
  }

  function showIssuedPart(state, part) {
    const row = part.row ??= element(panel.parts.list, 'li');
    row.replaceChildren();
    updateSection(panel.parts);
    const retained = state.retained.get(part);
    if (retained) {
      const link = element(row, 'a', `Скачать часть ${part.number} (${part.type})`);
      link.href = retained.url;
      link.download = part.filename;
      link.title = part.filename;
      return link;
    }
    const button = element(row, 'button', `Собрать часть ${part.number} заново`);
    button.type = 'button';
    button.disabled = Boolean(operation);
    button.addEventListener('click', () => run('download', current.callsign, part));
  }

  function retainIssuedPart(state, part, url, size) {
    // Keep recent files available as links. Older parts retain their list of awards for retry.
    for (const [previous, retained] of state.retained) {
      if (state.bytes + size <= maxRetainedIssuedBytes) break;
      URL.revokeObjectURL(retained.url);
      state.retained.delete(previous);
      state.bytes -= retained.size;
      showIssuedPart(state, previous);
    }
    state.retained.set(part, {url, size});
    state.bytes += size;
    return showIssuedPart(state, part);
  }

  function selectCallsign(callsign) {
    if (current?.callsign === callsign) return;
    if (current) {
      const fileUrl = panel?.save.getAttribute('href');
      if (fileUrl) setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
      forgetIssuedParts(current.issuedDownload);
      panel?.host.remove();
      panel = undefined;
      for (const item of current.downloads.values()) item.row = undefined;
      if (!current.downloads.size && !current.pendingRun?.visited.size &&
          (!current.issuedDownload || current.issuedDownload.finished)) {
        sessions.delete(current.callsign);
      }
    }
    current = sessions.get(callsign) ?? {
      callsign,
      fileTag: globalThis.hamlogCallsign.fileTag(callsign),
      downloads: new Map()
    };
    sessions.set(callsign, current);
  }

  function showPanel() {
    if (!panel) {
      const host = document.createElement('div');
      const shadow = host.attachShadow({mode: 'closed'});
      const styles = new CSSStyleSheet();
      styles.replaceSync(css);
      shadow.adoptedStyleSheets = [styles];

      const box = element(shadow, 'aside', '', 'panel');
      box.setAttribute('aria-label', `Дипломы HAMLOG для ${current.callsign}`);
      const header = element(box, 'header');
      element(header, 'h2', `Дипломы HAMLOG · ${current.callsign}`);
      const action = element(header, 'button', 'Закрыть');
      action.type = 'button';
      action.addEventListener('click', () => {
        if (!operation) {
          host.hidden = true;
          return;
        }
        operation.stopping = true;
        action.disabled = true;
        if (operation.mode === 'scan') {
          operation.controller.abort();
          panel.status.textContent = 'Останавливаем проверку…';
        } else if (operation.mode === 'download') {
          void operation.progress?.deactivate().catch(() => {});
          operation.wakeRetry?.();
          panel.status.textContent = 'Остановимся после текущего файла…';
        } else {
          panel.status.textContent = 'Остановимся после текущей страницы…';
        }
      });
      const status = element(box, 'p');
      status.setAttribute('role', 'status');
      const detail = element(box, 'p', '', 'detail');
      const progress = element(box, 'progress');
      progress.setAttribute('aria-label', 'Ход обработки дипломов');
      progress.hidden = true;
      const save = element(box, 'a', '', 'save');
      save.hidden = true;
      const parts = section(box, 'Файлы для скачивания');
      parts.details.open = true;
      const owned = section(box, 'Ранее выданы');
      const unknown = section(box, 'Программы без записи о выдаче');
      const received = section(box, 'Новые дипломы');
      const issues = section(box, 'Требуют внимания');
      panel = {host, action, status, detail, progress, save, parts, owned, unknown, received, issues};
      const issuedState = current.issuedDownload;
      for (const part of issuedState?.parts ?? []) showIssuedPart(issuedState, part);
      for (const item of current.downloads.values()) {
        item.row = addRow(received, item.award.label || item.award.title, item.award.downloadUrl, 'Скачать');
      }
    }

    if (!panel.host.isConnected) document.documentElement.append(panel.host);
    panel.host.hidden = false;
    return panel;
  }

  function showProgress(done, total) {
    panel.progress.hidden = false;
    panel.progress.max = Math.max(total, 1);
    panel.progress.value = done;
  }

  function warn(message, entry) {
    const prefix = entry?.title ? `${entry.title}. ` : '';
    addRow(panel.issues, `${prefix}${message}`, entry?.url, 'Открыть');
  }

  function explain(error, fallback) {
    return typeof error?.userMessage === 'string' && error.userMessage.trim()
      ? error.userMessage
      : fallback;
  }

  function clear(group) {
    group.list.replaceChildren();
    updateSection(group);
  }

  function pageKey(value) {
    const url = safeUrl(value);
    return url ? new URL(url).pathname.replace(/\/+$/, '') : null;
  }

  async function readCatalog(site, signal) {
    panel.status.textContent = 'Собираем программы из каталога HAMLOG…';
    panel.progress.hidden = false;
    panel.progress.removeAttribute('value');
    const catalog = await site.catalog(signal);
    signal.throwIfAborted();
    for (const message of catalog.warnings ?? []) warn(message);
    if (!Array.isArray(catalog.entries) || !catalog.entries.length || !Array.isArray(catalog.issued)) {
      const error = new Error('Incomplete catalog');
      error.userMessage = 'Каталог или список выданных дипломов не загрузился. Повторите проверку.';
      throw error;
    }
    return catalog;
  }

  async function scan(site, job) {
    clear(panel.owned);
    clear(panel.unknown);
    const catalog = await readCatalog(site, job.controller.signal);
    const knownPages = new Set(catalog.issued.map(award => pageKey(award.url)).filter(Boolean));
    for (const award of catalog.issued) {
      addRow(panel.owned, award.label || award.title, award.downloadUrl || award.url, 'Открыть');
    }
    let unknown = 0;
    for (const entry of catalog.entries) {
      if (!knownPages.has(pageKey(entry.url))) {
        addRow(panel.unknown, entry.title, null);
        unknown += 1;
      }
    }
    showProgress(catalog.entries.length, catalog.entries.length);
    panel.status.textContent = catalog.warnings?.length ? 'Каталог сверён с пропусками.' : 'Каталог сверён с выданными дипломами.';
    panel.detail.textContent = `Программ: ${catalog.entries.length}. Выдано дипломов: ${catalog.issued.length}. Без записи о выдаче: ${unknown}. HAMLOG проверит выполнение условий при запуске «Получить и скачать новые».`;
  }

  function filename(value) {
    const sanitized = String(value ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
    if (!sanitized) return `HAMLOG-${current.fileTag}-диплом.pdf`;
    return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(sanitized) ? `_${sanitized}` : sanitized;
  }

  function issuedFileUrl(award) {
    const target = safeUrl(award?.downloadUrl);
    return target && new URL(target).pathname === '/dl.php' ? target : null;
  }

  function waitForRetry(job, delay, wakeOnConnect) {
    return new Promise(resolve => {
      const wake = () => {
        clearTimeout(timer);
        globalThis.removeEventListener('online', wake);
        job.wakeRetry = undefined;
        resolve();
      };
      const timer = setTimeout(wake, delay);
      job.wakeRetry = wake;
      if (wakeOnConnect) globalThis.addEventListener('online', wake, {once: true});
    });
  }

  async function retryIssued(job, request) {
    const status = panel.status.textContent;
    let backoff = 2_000;
    while (!job.stopping) {
      try {
        const result = await request();
        if (!job.stopping && panel.status.textContent !== status) panel.status.textContent = status;
        return result;
      } catch (error) {
        if (!error?.retryable) throw error;
        if (job.stopping) break;
        const delay = navigator.onLine ? backoff : maxRetryDelay;
        panel.status.textContent = 'Связь с HAMLOG прервалась. Продолжим автоматически…';
        await waitForRetry(job, Math.max(delay, error.retryAfter ?? 0), !error.retryAfter);
        backoff = Math.min(backoff * 2, maxRetryDelay);
      }
    }
  }

  async function readFile(site, award, signal, job) {
    try {
      const read = () => site.readCertificate(award.downloadUrl, signal);
      const result = job ? await retryIssued(job, read) : await read();
      if (!result && job?.stopping) return null;
      const {blob, filename: originalName} = result;
      if (!(blob instanceof Blob) || !blob.size) throw new Error('Empty certificate');
      return {blob, filename: filename(originalName)};
    } catch (error) {
      if (error?.fatal) throw error;
      warn(explain(error, 'Выданный диплом не удалось скачать.'), award);
      return null;
    }
  }

  async function sendDownloads(files, issuedState, restoredPart, progress) {
    if (!files.size) return false;
    const isArchive = files.size > 1;
    const partNumber = restoredPart?.number ?? (issuedState ? issuedState.parts.length + 1 : undefined);
    let file;
    let url;
    try {
      const certificates = [...files.values()];
      file = certificates[0];
      if (isArchive) {
        const date = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Moscow'}).format(new Date());
        const suffix = partNumber ? `-part-${partNumber}` : '';
        file = {
          blob: await globalThis.hamlogCertificateArchive.create(certificates),
          filename: `HAMLOG-${current.fileTag}-${date}${suffix}.zip`
        };
      }
      url = URL.createObjectURL(file.blob);
    } catch (error) {
      warn(explain(error, 'Не удалось подготовить файлы. Используйте ссылки ниже или повторите скачивание.'));
      return false;
    }

    let link;
    if (issuedState) {
      const part = restoredPart ?? {
        number: partNumber, keys: [...files.keys()], filename: file.filename, type: isArchive ? 'ZIP' : 'PDF'
      };
      if (progress) {
        let saved;
        try {
          saved = await progress.save(part, url);
        } finally {
          if (!saved) URL.revokeObjectURL(url);
        }
        if (!saved) {
          warn('Браузер не завершил сохранение части. Нажмите «Скачать выданные», чтобы повторить сохранение.');
          return false;
        }
        part.durable = true;
      }
      if (!restoredPart) issuedState.parts.push(part);
      link = retainIssuedPart(issuedState, part, url, file.blob.size);
      if (restoredPart || progress) return true;
    } else {
      link = document.createElement('a');
      link.href = url;
      link.download = file.filename;
      link.title = file.filename;
      const previousLink = panel.save;
      const previousUrl = previousLink.getAttribute('href');
      link.className = 'save';
      link.textContent = isArchive ? 'Скачать последний ZIP-архив' : 'Скачать последний PDF';
      previousLink.replaceWith(link);
      panel.save = link;
      if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 60_000);
    }
    try {
      link.click();
    } catch (error) {
      warn(explain(error, 'Браузер не запустил скачивание. Нажмите на ссылку готового файла.'));
    }

    return true;
  }

  async function downloadBatch(site, signal, downloads, {
    issuedState, job, onFile, onSaved
  } = {}) {
    const files = new Map();
    let size = 0;
    let saved = false;
    let limited = false;
    const activeText = panel.status.textContent;
    try {
      for (const [key, {award}] of downloads) {
        if (job?.stopping) break;
        if (files.size >= maxPreparedFiles || size >= maxPreparedBytes) {
          limited = true;
          break;
        }
        let file;
        if (issuedState?.nextFile?.key === key) {
          file = issuedState.nextFile.file;
          issuedState.nextFile = undefined;
        } else if (issuedState?.staged?.has(key)) {
          file = await job.progress.file(key);
        } else {
          file = await readFile(site, award, signal, job);
          if (file && job?.progress) {
            await job.progress.stage(key, file);
            issuedState.staged.add(key);
          }
        }
        if (!file && job?.stopping) break;
        if (file) {
          if (size + file.blob.size > maxPreparedBytes) {
            if (issuedState) issuedState.nextFile = {key, file};
            limited = true;
            break;
          }
          size += file.blob.size;
          files.set(key, file);
        }
        onFile?.(key, Boolean(file));
      }
    } finally {
      if (files.size && job?.progress) panel.status.textContent = 'Браузер сохраняет готовую часть…';
      saved = await sendDownloads(files, issuedState, undefined, job?.progress);
      if (files.size && job?.progress) panel.status.textContent = activeText;
      if (saved) {
        for (const key of files.keys()) {
          downloads.get(key).row?.append(' · файл готов к скачиванию');
          downloads.delete(key);
        }
        onSaved?.(files.keys());
      }
    }
    return {saved, count: files.size, limited};
  }

  async function prepareDownloads(site, signal) {
    const {downloads} = current;
    if (!downloads.size) return {saved: false, count: 0};
    panel.status.textContent = 'Собираем файлы новых дипломов…';
    current.moreFiles = false;
    const result = await downloadBatch(site, signal, downloads);
    current.moreFiles = result.limited;
    return result;
  }

  function showDownloadResult({saved, count}) {
    if (saved) {
      panel.detail.textContent += count === 1 ? ' PDF готов к скачиванию.' : ' ZIP-архив готов к скачиванию.';
    }
    if (current.moreFiles) {
      panel.detail.textContent += ' Остальные дипломы доступны по ссылкам ниже. Для следующей части снова нажмите «Получить и скачать новые».';
    } else if (current.downloads.size) {
      panel.detail.textContent += ` Файлов для повторной попытки: ${current.downloads.size}.`;
    }
  }

  function confirmNew(owned) {
    if (!Array.isArray(owned)) throw new Error('Missing issued awards');
    const {downloads, pendingRun} = current;
    let issued = 0;
    for (const award of owned) {
      if (!award.key || pendingRun.before.has(award.key) || !pendingRun.visited.has(pageKey(award.url))) continue;
      pendingRun.before.add(award.key);
      const label = award.label || award.title;
      const target = safeUrl(award.downloadUrl);
      const downloadUrl = target && new URL(target).pathname === '/dl.php' ? target : null;
      const row = addRow(panel.received, label, downloadUrl || award.url, downloadUrl ? 'Скачать' : 'Открыть');
      if (downloadUrl) {
        downloads.set(award.key, {award: {...award, downloadUrl}, row});
      } else {
        warn('Диплом выдан. Ссылка на файл недоступна.', award);
      }
      issued += 1;
    }
    current.pendingRun = undefined;
    return issued;
  }

  async function claim(site, job) {
    const {signal} = job.controller;
    if (current.moreFiles) {
      panel.action.disabled = true;
      panel.status.textContent = 'Проверяем вход перед скачиванием следующей части…';
      await site.owned(signal);
      const result = await prepareDownloads(site, signal);
      panel.status.textContent = 'Обработка следующей части завершена.';
      panel.detail.textContent = `Подготовлено файлов: ${result.count}.`;
      showDownloadResult(result);
      return;
    }
    const catalog = await readCatalog(site, signal);
    let issued = current.pendingRun ? confirmNew(catalog.issued) : 0;
    const pendingRun = {
      before: new Set(catalog.issued.map(award => award.key)),
      visited: new Set()
    };
    current.pendingRun = pendingRun;

    let done = 0;
    panel.status.textContent = 'Проверяем условия и получаем бесплатные дипломы…';
    showProgress(0, catalog.entries.length);
    for (const entry of catalog.entries) {
      if (job.stopping) break;
      const page = pageKey(entry.url);
      if (!page) {
        warn('Адрес программы не поддерживается.', entry);
      } else {
        try {
          pendingRun.visited.add(page);
          const result = await site.inspect(entry, signal, {allowIssue: true});
          for (const message of result.warnings ?? []) warn(message, entry);
        } catch (error) {
          if (error?.fatal) throw error;
          warn(explain(error, 'Страница не подтвердила результат проверки.'), entry);
        }
      }
      done += 1;
      showProgress(done, catalog.entries.length);
      panel.detail.textContent = `Обработано программ: ${done} из ${catalog.entries.length}.`;
    }

    panel.action.disabled = true;
    if (pendingRun.visited.size) {
      panel.status.textContent = 'Сверяем новые выдачи со списком HAMLOG…';
      issued += confirmNew(await site.owned(signal));
    } else {
      current.pendingRun = undefined;
    }

    const result = await prepareDownloads(site, signal);

    if (job.stopping) {
      panel.status.textContent = 'Проверка остановлена.';
    } else {
      panel.status.textContent = panel.issues.list.childElementCount
        ? 'Проверка и получение завершены с пропусками.'
        : 'Проверка и получение завершены.';
    }
    panel.detail.textContent = `Обработано программ: ${done} из ${catalog.entries.length}. Новых дипломов: ${issued}.`;
    showDownloadResult(result);
  }

  function keyedAwards(awards) {
    const {key} = globalThis.hamlogIssuedProgress;
    return Promise.all(awards.map(async award => ({...award, key: await key(award.key)})));
  }

  function issuedStateFor(progress) {
    const state = current.issuedDownload ??= {
      saved: new Set(), failed: new Set(), parts: [], retained: new Map(), bytes: 0
    };
    if (progress) {
      state.durable = true;
      state.saved = new Set(progress.parts.flatMap(part => part.keys));
      state.staged = new Set(progress.staged);
      for (const data of progress.parts.slice(state.parts.length)) {
        const part = {...data, durable: true};
        state.parts.push(part);
        showIssuedPart(state, part);
      }
    }
    return state;
  }

  async function downloadIssued(site, job) {
    const {signal} = job.controller;
    panel.status.textContent = 'Читаем список уже выданных дипломов…';
    clear(panel.owned);
    clear(panel.unknown);
    const issued = await retryIssued(job, () => site.owned(signal));
    if (job.stopping) {
      panel.status.textContent = 'Подготовка дипломов остановлена.';
      return;
    }
    const awards = job.progress ? await keyedAwards(issued) : issued;
    const availableKeys = new Set(awards.map((award) => award.key));
    const progress = job.progress && await job.progress.load([...availableKeys]);
    if (current.issuedDownload && (
      Boolean(current.issuedDownload.durable) !== Boolean(progress) ||
      (!progress && (current.issuedDownload.finished || !awards.length))
    )) {
      forgetIssuedParts(current.issuedDownload);
      clear(panel.parts);
      current.issuedDownload = undefined;
    }
    const state = issuedStateFor(progress);
    if (!awards.length) {
      panel.status.textContent = 'HAMLOG пока не показывает выданных дипломов для этого позывного.';
      return;
    }

    if (state.nextFile && !availableKeys.has(state.nextFile.key)) state.nextFile = undefined;
    for (const seen of [state.saved, state.failed]) {
      for (const key of seen) {
        if (!availableKeys.has(key)) seen.delete(key);
      }
    }

    const pending = new Map();
    const retry = new Map();
    let missingLinks = 0;
    for (const award of awards) {
      const url = issuedFileUrl(award);
      const row = addRow(panel.owned, award.label || award.title, url, 'Скачать');
      if (state.saved.has(award.key)) {
        row.append(progress ? ' · файл сохранён' : ' · файл подготовлен');
      } else if (!url) {
        row.append(' · ссылка на файл недоступна');
        state.failed.add(award.key);
        missingLinks += 1;
      } else {
        const request = {award: {...award, url, downloadUrl: url}, row};
        if (state.failed.has(award.key)) {
          row.append(' · предыдущая попытка не удалась');
          retry.set(award.key, request);
        } else {
          pending.set(award.key, request);
        }
      }
    }
    if (missingLinks) {
      warn(`Ссылок на файлы не найдено: ${missingLinks}. Посмотрите раздел «Мои полученные дипломы» в HAMLOG.`,
        {url: origin + '/account/awards.php'});
    }

    const retrying = !pending.size && retry.size > 0;
    const remainingDownloads = retrying ? retry : pending;
    const candidates = progress ? new Map([
      ...[...remainingDownloads].filter(([key]) => state.staged.has(key)),
      ...[...remainingDownloads].filter(([key]) => !state.staged.has(key))
    ]) : remainingDownloads;
    const total = retrying ? retry.size : awards.length;
    let processed = retrying ? 0 : state.saved.size + state.failed.size;
    const reportProgress = () => {
      showProgress(processed, total);
      panel.detail.textContent = `Обработано ${processed} из ${total}.`;
    };
    panel.status.textContent = retrying ? 'Повторяем скачивание оставшихся дипломов…' : 'Готовим файлы выданных дипломов…';
    reportProgress();
    const update = {
      issuedState: state,
      job,
      onFile: (key, ready) => {
        if (!ready) {
          state.failed.add(key);
          candidates.get(key).row.append(' · файл не подготовлен');
          candidates.delete(key);
        }
        processed += 1;
        reportProgress();
      },
      onSaved: (keys) => {
        for (const key of keys) {
          state.saved.add(key);
          state.failed.delete(key);
          state.staged?.delete(key);
        }
      }
    };

    while (candidates.size && !job.stopping) {
      const result = await downloadBatch(site, signal, candidates, update);
      if (!result.limited || !result.saved) break;
    }

    const remaining = awards.length - state.saved.size - state.failed.size;
    if (job.stopping) panel.status.textContent = 'Подготовка дипломов остановлена.';
    else if (remaining) panel.status.textContent = 'Часть дипломов ещё не подготовлена.';
    else if (state.failed.size) panel.status.textContent = 'Обработка завершена с пропусками.';
    else panel.status.textContent = progress ? 'Все выданные дипломы сохранены.' : 'Все выданные дипломы подготовлены.';
    panel.detail.textContent = `${progress ? 'Сохранено' : 'Готово'} файлов: ${state.saved.size} из ${awards.length}.`;
    if (state.parts.length && !progress) {
      panel.detail.textContent += ' Если браузер пропустил загрузку, скачайте нужную часть из панели.';
    }
    if (remaining || (retrying && candidates.size) || state.failed.size > missingLinks) {
      panel.detail.textContent += ' Чтобы продолжить, снова нажмите «Скачать выданные».';
      if (!progress) panel.detail.textContent += ' Список сохраняется, пока эта вкладка открыта.';
    }
    if (state.failed.size) {
      panel.detail.textContent += ` Пока не подготовлено файлов: ${state.failed.size}. Ссылки для ручного скачивания — в списке ниже.`;
      panel.owned.details.open = true;
    }
    state.finished = !remaining && !state.failed.size;
  }

  async function restoreIssuedPart(site, job, part) {
    const {signal} = job.controller;
    panel.status.textContent = `Собираем часть ${part.number} заново…`;
    showProgress(0, part.keys.length);
    const issued = await retryIssued(job, () => site.owned(signal));
    if (job.stopping) {
      panel.status.textContent = 'Подготовка части остановлена.';
      return;
    }
    const identifiable = part.durable ? await keyedAwards(issued) : issued;
    const awards = new Map(identifiable.map(award => [award.key, award]));
    const files = new Map();
    let size = 0;
    for (const key of part.keys) {
      if (job.stopping) break;
      const award = awards.get(key);
      const downloadUrl = issuedFileUrl(award);
      if (!downloadUrl) {
        warn('Ссылка на диплом недоступна. Проверьте список выданных дипломов в HAMLOG.',
          {title: award?.label || award?.title, url: origin + '/account/awards.php'});
        break;
      }
      const file = await readFile(site, {...award, url: downloadUrl, downloadUrl}, signal, job);
      if (!file) break;
      size += file.blob.size;
      if (size > maxPreparedBytes) {
        warn('После изменений в HAMLOG файлы этой части больше не помещаются в один архив.',
          {url: origin + '/account/awards.php'});
        break;
      }
      files.set(key, file);
      showProgress(files.size, part.keys.length);
    }

    if (job.stopping) {
      panel.status.textContent = 'Подготовка части остановлена.';
    } else if (files.size === part.keys.length && await sendDownloads(files, current.issuedDownload, part)) {
      panel.status.textContent = `Часть ${part.number} готова. Нажмите на ссылку в списке файлов.`;
    } else {
      panel.status.textContent = `Не удалось собрать часть ${part.number} целиком.`;
    }
  }

  function run(mode, value, part, progressToken) {
    if (mode !== 'scan' && mode !== 'claim' && mode !== 'download') return {ok: false};
    if (operation) {
      showPanel();
      return {ok: true, busy: true, resumable: Boolean(progressToken && operation.progressToken === progressToken), callsign: current.callsign};
    }
    const callsign = globalThis.hamlogCallsign?.normalize?.(value);
    if (!callsign) return {ok: false};
    selectCallsign(callsign);
    if (part && (mode !== 'download' || !current.issuedDownload?.parts.includes(part))) return {ok: false};
    showPanel();
    const site = globalThis.hamlogSite?.create?.(callsign);
    const issuedProgress = globalThis.hamlogIssuedProgress;
    if (!site || !issuedProgress) {
      panel.status.textContent = 'Расширение не готово к работе в этой вкладке.';
      return {ok: false};
    }

    const progress = progressToken && issuedProgress.connect(progressToken);
    const job = {mode, controller: new AbortController(), stopping: false, progress, progressToken};
    operation = job;
    panel.action.textContent = 'Остановить';
    panel.action.disabled = false;
    panel.status.textContent = 'Запускаем…';
    panel.detail.textContent = '';
    panel.progress.hidden = true;
    for (const button of panel.parts.list.querySelectorAll('button')) button.disabled = true;

    void issuedProgress.runExclusive(async lock => {
      if (!lock) {
        panel.status.textContent = 'Обработка уже идёт в другой вкладке HAMLOG.';
        return;
      }
      clear(panel.issues);
      if (progress && job.stopping) {
        panel.status.textContent = 'Подготовка дипломов остановлена.';
        return;
      }
      if (mode === 'scan') await scan(site, job);
      else if (mode === 'claim') await claim(site, job);
      else if (part) await restoreIssuedPart(site, job, part);
      else await downloadIssued(site, job);
    }, Boolean(progress), () => {
      job.stopping = true;
      job.connectionLost = true;
      job.controller.abort();
    }).catch((error) => {
      if (job.connectionLost) {
        panel.status.textContent = 'Связь с расширением прервалась. Запустите команду ещё раз.';
      } else if (job.controller.signal.aborted) {
        panel.status.textContent = 'Проверка остановлена.';
      } else {
        panel.status.textContent = explain(error, 'Обработка прервана. Проверьте вход в HAMLOG и повторите попытку.');
        if (mode === 'claim' && current.pendingRun?.visited.size) {
          panel.detail.textContent += ' При повторном запуске в этой вкладке сверим результаты прерванной проверки.';
        }
      }
    }).finally(async () => {
      if (!job.connectionLost) await progress?.deactivate().catch(() => {});
      operation = undefined;
      panel.action.textContent = 'Закрыть';
      panel.action.disabled = false;
      for (const button of panel.parts.list.querySelectorAll('button')) button.disabled = false;
      panel.received.details.open = panel.received.list.childElementCount > 0;
      panel.issues.details.open = panel.issues.list.childElementCount > 0;
      if (!panel.progress.hasAttribute('value')) panel.progress.hidden = true;
    });

    return {ok: true};
  }

  globalThis.hamlogAwards = Object.freeze({run});
})();
