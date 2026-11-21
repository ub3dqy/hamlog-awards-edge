(() => {
  'use strict';

  const origin = 'https://hamlog.online';
  if (location.origin !== origin || globalThis.hamlogAwards) return;

  const maxPreparedFiles = 100;
  const maxPreparedBytes = 96 * 1024 * 1024;
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

  function selectCallsign(callsign) {
    if (current?.callsign === callsign) return;
    if (current) {
      const fileUrl = panel?.save.getAttribute('href');
      if (fileUrl) setTimeout(() => URL.revokeObjectURL(fileUrl), 60_000);
      panel?.host.remove();
      panel = undefined;
      for (const item of current.downloads.values()) item.row = undefined;
      if (!current.downloads.size && !current.pendingRun?.visited.size) sessions.delete(current.callsign);
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
      const owned = section(box, 'Ранее выданы');
      const unknown = section(box, 'Программы без записи о выдаче');
      const received = section(box, 'Новые дипломы');
      const issues = section(box, 'Требуют внимания');
      panel = {host, action, status, detail, progress, save, owned, unknown, received, issues};
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

  async function readFile(site, award, signal) {
    try {
      const {blob, filename: originalName} = await site.readCertificate(award.downloadUrl, signal);
      if (!(blob instanceof Blob) || !blob.size) throw new Error('Empty certificate');
      return {blob, filename: filename(originalName)};
    } catch (error) {
      if (error?.fatal) throw error;
      warn(explain(error, 'Выданный диплом не удалось скачать.'), award);
      return null;
    }
  }

  async function sendDownloads(files) {
    if (!files.size) return false;
    const isArchive = files.size > 1;
    let file;
    let url;
    try {
      const certificates = [...files.values()];
      file = certificates[0];
      if (isArchive) {
        const date = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Moscow'}).format(new Date());
        file = {blob: await globalThis.hamlogCertificateArchive.create(certificates), filename: `HAMLOG-${current.fileTag}-${date}.zip`};
      }
      url = URL.createObjectURL(file.blob);
    } catch (error) {
      warn(explain(error, 'Не удалось подготовить файлы. Откройте ссылки в списке «Новые дипломы» или повторите скачивание.'));
      return false;
    }

    const link = panel.save;
    const previousUrl = link.getAttribute('href');
    link.href = url;
    link.download = file.filename;
    link.title = file.filename;
    link.textContent = isArchive ? 'Скачать последний ZIP-архив' : 'Скачать последний PDF';
    link.hidden = false;
    if (previousUrl) setTimeout(() => URL.revokeObjectURL(previousUrl), 60_000);
    try {
      link.click();
    } catch (error) {
      warn(explain(error, 'Edge не запустил скачивание. Нажмите на ссылку готового файла.'));
    }

    const {downloads} = current;
    for (const key of files.keys()) {
      downloads.get(key).row.append(' · файл готов к скачиванию');
      downloads.delete(key);
    }
    return true;
  }

  async function prepareDownloads(site, signal) {
    const {downloads} = current;
    if (!downloads.size) return {saved: false, count: 0};
    panel.status.textContent = 'Собираем файлы новых дипломов…';
    const files = new Map();
    let size = 0;
    let saved = false;
    current.moreFiles = false;
    try {
      for (const [key, {award}] of downloads) {
        if (files.size >= maxPreparedFiles || size >= maxPreparedBytes) {
          current.moreFiles = true;
          break;
        }
        const file = await readFile(site, award, signal);
        if (!file) continue;
        if (size + file.blob.size > maxPreparedBytes) {
          current.moreFiles = true;
          break;
        }
        size += file.blob.size;
        files.set(key, file);
      }
    } finally {
      saved = await sendDownloads(files);
    }
    return {saved, count: files.size};
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

  function run(mode, value) {
    if (mode !== 'scan' && mode !== 'claim') return {ok: false};
    if (operation) {
      showPanel();
      return {ok: true, busy: true, callsign: current.callsign};
    }
    const callsign = globalThis.hamlogCallsign?.normalize?.(value);
    if (!callsign) return {ok: false};
    selectCallsign(callsign);
    showPanel();
    const site = globalThis.hamlogSite?.create?.(callsign);
    if (!site || typeof navigator.locks?.request !== 'function') {
      panel.status.textContent = 'Расширение не готово к работе в этой вкладке.';
      return {ok: false};
    }

    const job = {mode, controller: new AbortController(), stopping: false};
    operation = job;
    panel.action.textContent = 'Остановить';
    panel.action.disabled = false;
    panel.status.textContent = 'Запускаем…';
    panel.detail.textContent = '';
    panel.progress.hidden = true;

    void navigator.locks.request('hamlog-awards-operation', {ifAvailable: true}, async (lock) => {
      if (!lock) {
        panel.status.textContent = 'Обработка уже идёт в другой вкладке HAMLOG.';
        return;
      }
      clear(panel.issues);
      if (mode === 'scan') await scan(site, job);
      else await claim(site, job);
    }).catch((error) => {
      if (job.controller.signal.aborted) {
        panel.status.textContent = 'Проверка остановлена.';
      } else {
        panel.status.textContent = explain(error, 'Обработка прервана. Проверьте вход в HAMLOG и повторите попытку.');
        if (mode === 'claim' && current.pendingRun?.visited.size) {
          panel.detail.textContent += ' При повторном запуске в этой вкладке сверим результаты прерванной проверки.';
        }
      }
    }).finally(() => {
      operation = undefined;
      panel.action.textContent = 'Закрыть';
      panel.action.disabled = false;
      panel.received.details.open = panel.received.list.childElementCount > 0;
      panel.issues.details.open = panel.issues.list.childElementCount > 0;
      if (!panel.progress.hasAttribute('value')) panel.progress.hidden = true;
    });

    return {ok: true};
  }

  globalThis.hamlogAwards = Object.freeze({run});
})();
