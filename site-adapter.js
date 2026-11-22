(() => {
  'use strict';

  if (globalThis.hamlogSite) return;

  const origin = 'https://hamlog.online';
  const account = '/account/awards.php';
  const myCallsigns = '/account/calls.php';
  const downloadPath = '/dl.php';
  const pageSize = 100;
  const maxPdfBytes = 24 * 1024 * 1024;
  const pdfMagic = [0x25, 0x50, 0x44, 0x46, 0x2d];
  const specialRoutes = new Set([
    '/account/dxcc.php', '/account/usaca.php', '/account/was.php',
    '/13col/', '/gb/', '/helvetia/info.php', '/icd/', '/idd/', '/krv/hunter2025/',
    '/neca/info.php', '/raem/', '/rrnars/', '/sia/', '/thefirstinthenation/'
  ]);
  let nextRequestAt = 0;

  function siteError(message, fatal = false) {
    const error = new Error(message);
    error.userMessage = message;
    error.fatal = fatal;
    return error;
  }

  function stop(message) {
    return siteError(message, true);
  }

  function retryableError(message, fatal = false, retryAfter = 0) {
    const error = siteError(message, fatal);
    error.retryable = true;
    error.retryAfter = retryAfter;
    return error;
  }

  function retryAfterDelay(response) {
    const value = response.headers.get('retry-after')?.trim();
    if (!value) return 0;
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
    return Number.isFinite(delay) ? Math.min(2_147_483_647, Math.max(0, delay)) : 0;
  }

  function localUrl(value, base = origin) {
    if (!value) return null;
    try {
      const url = new URL(value, base);
      return url.origin === origin && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function awardUrl(value, base) {
    const url = localUrl(value, base);
    if (!url || url.search || url.hash || !supportedAward(url.pathname)) return null;
    return url.href;
  }

  function certificateUrl(value) {
    const url = localUrl(value);
    if (!url || url.pathname !== downloadPath || url.hash) return null;
    const params = url.searchParams;
    return params.size === 1 && /^[A-Za-z0-9_-]{16,256}$/.test(params.get('i') ?? '')
      ? url.href : null;
  }

  // A detached template keeps scripts, images and frames inert.
  function parse(html) {
    const template = document.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  function label(node) {
    return node?.textContent.replace(/\s+/g, ' ').trim() || '';
  }

  async function request(path, signal, { body, xhr = false, referrer } = {}, consume) {
    const url = localUrl(path);
    if (location.origin !== origin || !url) throw stop('Откройте вкладку HAMLOG.');
    signal.throwIfAborted();
    const delay = nextRequestAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    signal.throwIfAborted();
    nextRequestAt = Date.now() + 900;
    const headers = xhr ? { 'X-Requested-With': 'XMLHttpRequest' } : {};
    const timeout = AbortSignal.timeout(24_000);
    try {
      const response = await fetch(url.href, {
        method: body ? 'POST' : 'GET', body, headers,
        credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
        referrer, referrerPolicy: 'same-origin',
        signal: AbortSignal.any([signal, timeout])
      });
      if (response.status === 429) {
        throw stop('HAMLOG ограничил запросы или временно недоступен. Повторите позже.');
      }
      if ([408, 502, 503, 504].includes(response.status)) {
        throw retryableError('HAMLOG временно недоступен. Повторите позже.',
          response.status === 503, retryAfterDelay(response));
      }
      if (response.status === 401 || response.status === 403) {
        throw stop('HAMLOG не подтвердил доступ. Проверьте, что вы вошли в кабинет.');
      }
      if (response.type === 'opaqueredirect' || response.redirected) {
        const error = siteError('HAMLOG перенаправил запрос. Откройте страницу вручную.');
        error.redirected = true;
        throw error;
      }
      if (!response.ok) throw siteError(`HAMLOG вернул ошибку ${response.status}.`);
      return await consume(response);
    } catch (error) {
      signal.throwIfAborted();
      if (timeout.aborted || error.name === 'TimeoutError') throw retryableError('HAMLOG не ответил вовремя.');
      if (error instanceof TypeError || error.name === 'AbortError') {
        throw retryableError('Не удалось связаться с HAMLOG.');
      }
      throw error;
    }
  }

  function page(path, signal) {
    return request(path, signal, {}, async (response) => parse(await response.text()));
  }

  function signedIn(root) {
    const sessionIndicator = root.querySelector('a[href$="/account/logout.php"], a[href="logout.php"]');
    if (!sessionIndicator) throw stop('Войдите в свой кабинет HAMLOG и повторите.');
  }

  function matchesCallsign(node, callsign) {
    return globalThis.hamlogCallsign.normalize(node?.textContent) === callsign;
  }

  function isActiveCallsign(root, callsign) {
    const stationLinks = [...root.querySelectorAll('a[href*="outboundqsl.php"]')];
    return stationLinks.some((anchor) => matchesCallsign(anchor, callsign));
  }

  async function accountPage(callsign, signal) {
    const root = await page(account, signal);
    signedIn(root);
    if (!isActiveCallsign(root, callsign)) {
      const stations = await page(myCallsigns, signal);
      signedIn(stations);
      const tables = '#current-md .calls-table, #pasted-md .calls-table';
      if (!stations.querySelector(tables)) throw stop('HAMLOG не показал раздел «Мои позывные».');
      const names = stations.querySelectorAll(`:is(${tables}) tbody td:first-child .callsign-label`);
      if (![...names].some((name) => matchesCallsign(name, callsign))) {
        throw stop(`Позывного ${callsign} нет в разделе «Мои позывные» открытого кабинета HAMLOG.`);
      }
    }
    return root;
  }

  function emptyIssuedRow(cells, columnCount) {
    if (cells.length !== 1 || cells[0].querySelector('a[href], button, input')) return false;
    const cell = cells[0];
    if (cell.matches('.dataTables_empty, .dt-empty')) return true;
    const message = /^(?:записи отсутствуют|нет данных(?: в таблице)?|нет выданных дипломов|no data available in table|no matching records found|no awards issued)[.!…]*$/i;
    return cell.colSpan === columnCount && message.test(label(cell));
  }

  function issuedRows(root, callsign, {requireComplete = false} = {}) {
    const list = root.querySelector('#myawards-md #id1, #myawards-md #id2');
    const columns = list?.tHead?.rows[0]?.cells;
    if (columns?.length !== 6 || !list.tBodies.length) {
      throw stop('HAMLOG не показал ожидаемую таблицу уже выданных дипломов.');
    }
    const headings = Array.from(columns, label);
    const expected = [
      [1, /^(?:название|award name|title)$/i],
      [2, /^(?:позывной|call ?sign)$/i],
      [3, /^(?:дата выдачи|дата|issue date|date issued|date)$/i],
      [4, /^(?:номер диплома|award number|certificate number)$/i]
    ];
    if (expected.some(([index, pattern]) => !pattern.test(headings[index]) && headings.some(name => pattern.test(name)))) {
      throw stop('HAMLOG изменил порядок столбцов списка выданных дипломов. Выдача остановлена.');
    }

    const issued = new Map();
    const ambiguous = new Set();
    const normalize = globalThis.hamlogCallsign.normalize;
    let skipped = 0;
    for (const row of [...list.tBodies].flatMap((body) => [...body.rows])) {
      const cells = row.cells;
      if (emptyIssuedRow(cells, columns.length)) continue;
      if ((cells.length !== 5 && cells.length !== columns.length) ||
          [...cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1)) {
        skipped += 1;
        continue;
      }
      const station = normalize(label(cells[2].querySelector('a[href]'))) || normalize(label(cells[2]));
      if (!station) {
        skipped += 1;
        continue;
      }
      if (station !== callsign) continue;

      const program = cells[1].querySelector('a[href]');
      const title = label(cells[1]) || program?.getAttribute('title')?.replace(/\s+/g, ' ').trim();
      const date = label(cells[3]);
      const number = label(cells[4]);
      const hasDetails = /\p{Number}/u.test(date) && /\p{Number}/u.test(number);
      const url = awardUrl(program?.getAttribute('href'), origin + account);
      const downloadUrl = certificateUrl(cells[5]?.querySelector('a[href]')?.getAttribute('href'));
      // Without the last cell, date and number confirm that the earlier cells are in their usual positions.
      if (!title || (!hasDetails && (cells.length !== columns.length || (!url && !downloadUrl)))) {
        skipped += 1;
        continue;
      }
      const key = JSON.stringify([url || '', title.normalize('NFKC').toLowerCase(), date, number]);
      if (ambiguous.has(key)) {
        skipped += 1;
        continue;
      }
      const previous = issued.get(key);
      if (!hasDetails && previous && previous.downloadUrl !== downloadUrl) {
        // Download tokens can change. They cannot identify separate diplomas across sessions.
        issued.delete(key);
        ambiguous.add(key);
        skipped += 2;
        continue;
      }
      const awardLabel = number && !/^[-–—]+$/u.test(number) ? `${title} №${number}` : title;
      issued.set(key, {key, url, title, label: awardLabel, downloadUrl});
    }
    if (requireComplete && skipped) {
      throw stop('Получение новых дипломов приостановлено — не удалось сверить весь список. Уже выданные можно скачать отдельно.');
    }
    return {awards: [...issued.values()], skipped};
  }

  function catalogRequest(draw, start) {
    const body = new URLSearchParams({ draw, start, length: pageSize, 'search[value]': '', 'search[regex]': 'false' });
    for (const column of [0, 1, 2]) {
      const prefix = `columns[${column}]`;
      for (const [key, value] of Object.entries({ data: column, name: '', searchable: 'true', orderable: 'false' })) {
        body.set(`${prefix}[${key}]`, value);
      }
      body.set(`${prefix}[search][value]`, '');
      body.set(`${prefix}[search][regex]`, 'false');
    }
    return body;
  }

  async function catalog(callsign, signal, options) {
    const root = await accountPage(callsign, signal);
    const {awards: issued, skipped: skippedIssued} = issuedRows(root, callsign, options);
    const national = root.querySelector('#gnawards-md #listgn tbody');
    const territorial = root.querySelectorAll('#tcawards-md table tbody');
    if (!national || !territorial.length) {
      throw stop('HAMLOG не показал одну из частей каталога дипломов. Обновите страницу и повторите.');
    }
    const entries = new Map();
    const warnings = [];
    let unavailable = 0;

    function add(anchor) {
      const title = label(anchor);
      const url = awardUrl(anchor?.getAttribute('href'), origin + account);
      if (!title || !url) {
        unavailable += 1;
        return;
      }
      if (!entries.has(url)) entries.set(url, { title, url });
    }

    const staticBodies = [national, ...territorial];
    for (const row of staticBodies.flatMap((body) => [...body.rows])) {
      const anchor = [...row.querySelectorAll('a[href]')].find((link) =>
        !/(?:^|\/)activationlog\.php/i.test(link.getAttribute('href')));
      if (anchor) add(anchor);
    }

    let total;
    let rowCount = 0;
    do {
      const draw = Math.floor(rowCount / pageSize) + 1;
      const batch = await request('/account/awardsshow.php?tc', signal, {
        body: catalogRequest(draw, rowCount), xhr: true, referrer: origin + account + '?cr'
      }, (response) => response.json());
      if (!Number.isInteger(batch.recordsFiltered) || batch.recordsFiltered < 0 || batch.recordsFiltered > 20000 ||
          Number(batch.draw) !== draw || !Array.isArray(batch.data) ||
          (total !== undefined && total !== batch.recordsFiltered) ||
          batch.data.length !== Math.min(pageSize, batch.recordsFiltered - rowCount)) {
        throw stop('Каталог HAMLOG изменился при загрузке. Запустите проверку заново.');
      }
      total = batch.recordsFiltered;
      for (const row of batch.data) {
        if (!Array.isArray(row) || typeof row[1] !== 'string') {
          throw stop('HAMLOG изменил структуру списка клубных дипломов.');
        }
        add(parse(row[1]).querySelector('a[href]'));
      }
      rowCount += batch.data.length;
    } while (rowCount < total);

    if (unavailable) warnings.push(`Записей без доступной страницы диплома: ${unavailable}.`);
    return {entries: [...entries.values()], warnings, issued, skippedIssued};
  }

  function supportedAward(path) {
    return specialRoutes.has(path) ||
      /^\/(?:club\/[\w-]+|global\/[\w-]+\/[\w-]+)\/(?:[a-f0-9]{32}|\d+)\/$/.test(path) ||
      /^\/geo\/[\w-]+\/$/.test(path) ||
      /^\/(?:13colonies|iddicd\d{4})(?:\/[\w-]+)*\/$/.test(path);
  }

  async function inspect(callsign, entry, signal, { allowIssue } = {}) {
    const result = { url: entry.url, title: entry.title, warnings: [] };
    const url = localUrl(awardUrl(entry.url));
    if (!allowIssue) throw new Error('HAMLOG может выдать новый диплом при открытии его страницы.');
    if (!url) {
      result.warnings.push('У этой программы отдельная страница. Проверьте её вручную.');
      return result;
    }
    url.searchParams.set('call', callsign);
    let root;
    try {
      root = await page(url.href, signal);
    } catch (error) {
      if (!error.redirected) throw error;
      try {
        await accountPage(callsign, signal);
      } catch (accountError) {
        if (accountError.fatal) throw accountError;
        throw stop('После перенаправления HAMLOG не удалось подтвердить вход. Откройте свой кабинет и повторите.');
      }
      throw error;
    }
    signedIn(root);
    const summary = root.querySelector('.award-dashboard-summary');
    const call = root.querySelector('form.award-search-form #callsign');
    if (summary && globalThis.hamlogCallsign.normalize(call?.getAttribute('value')) === callsign) return result;
    result.warnings.push(`HAMLOG не показал результат ${callsign} на этой странице.`);
    return result;
  }

  function downloadForm(root, url) {
    const main = root.querySelector('main');
    const headings = [...main?.querySelectorAll('h1,h2,h3,h4,h5,h6') || []];
    if (!headings.some((heading) => /^(скачать бесплатный диплом|download (?:your )?free (?:award|certificate))$/i.test(label(heading)))) {
      throw siteError('На этой странице HAMLOG не подтвердил бесплатное скачивание.');
    }
    const button = [...main.querySelectorAll('form button[type="submit"]')].find((node) => /^(скачать|download)$/i.test(label(node)));
    const form = button?.closest('form');
    const action = form ? certificateUrl(localUrl(form.getAttribute('action') || url, url)?.href) : null;
    if (!form || action !== url || form.getAttribute('method')?.toLowerCase() !== 'post' ||
        [...button.attributes].some(({ name }) => /^form(?:action|method|enctype|target)$/.test(name))) {
      throw siteError('HAMLOG изменил форму скачивания. Используйте ссылку на диплом.');
    }
    const name = form.querySelector('input[type="text"][name="name"]');
    const csrf = form.querySelector('input[type="hidden"][name="csrf-download"]');
    const format = form.querySelector('input[type="radio"][name="format"][value="pdf"]');
    if (!name?.getAttribute('value')?.trim() || !csrf?.getAttribute('value') || !format ||
        [name, csrf, format].some((field) => field.hasAttribute('disabled'))) {
      throw siteError('Не найдены данные для загрузки PDF с HAMLOG.');
    }
    return new URLSearchParams({ name: name.getAttribute('value'), 'csrf-download': csrf.getAttribute('value'), format: 'pdf' });
  }

  async function readPdf(response) {
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const expectedSize = Number(response.headers.get('content-length'));
    if (type !== 'application/pdf' || !response.body || expectedSize > maxPdfBytes) {
      throw siteError('HAMLOG не вернул PDF диплома допустимого размера.');
    }

    const reader = response.body.getReader();
    const slices = [];
    const prefix = new Uint8Array(pdfMagic.length);
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const previousSize = size;
        size += value.byteLength;
        if (size > maxPdfBytes) throw siteError('Размер PDF диплома превышает допустимый предел.');
        if (previousSize < prefix.length) {
          const length = Math.min(value.byteLength, prefix.length - previousSize);
          for (let index = 0; index < length; index++) prefix[previousSize + index] = value[index];
          if (size >= prefix.length && pdfMagic.some((byte, index) => prefix[index] !== byte)) {
            throw siteError('Скачанный файл не прошёл проверку PDF.');
          }
        }
        slices.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    if (expectedSize > 0 && (!encoding || encoding === 'identity') && size !== expectedSize) {
      throw retryableError('Загрузка PDF прервалась.');
    }
    if (size < prefix.length) throw siteError('Скачанный файл не прошёл проверку PDF.');
    return new Blob(slices, { type });
  }

  async function readCertificate(callsign, value, signal) {
    const url = certificateUrl(value);
    if (!url) throw siteError('Не удалось подтвердить ссылку на диплом HAMLOG.');
    const root = await page(url, signal);
    const body = downloadForm(root, url);
    return request(url, signal, { body, referrer: url }, async (response) => {
      const blob = await readPdf(response);
      const disposition = response.headers.get('content-disposition') || '';
      const providedName = disposition.match(/\bfilename\s*=\s*"?([A-Z0-9_/-]{1,100}\.pdf)"?(?:;|$)/i)?.[1];
      const tag = globalThis.hamlogCallsign.fileTag(callsign);
      const filename = providedName && globalThis.hamlogCallsign.fileTag(providedName);
      return {
        blob, filename: filename?.toUpperCase().startsWith(`${tag}-`)
          ? filename : `${tag}-диплом-${crypto.randomUUID()}.pdf`
      };
    });
  }

  function create(value) {
    const callsign = globalThis.hamlogCallsign.normalize(value);
    if (!callsign) throw stop('Укажите позывной в настройках расширения.');
    return Object.freeze({
      catalog: (signal, options) => catalog(callsign, signal, options),
      owned: async (signal, options) => issuedRows(await accountPage(callsign, signal), callsign, options),
      inspect: (entry, signal, options) => inspect(callsign, entry, signal, options),
      readCertificate: (url, signal) => readCertificate(callsign, url, signal)
    });
  }

  globalThis.hamlogSite = Object.freeze({ create });
})();
