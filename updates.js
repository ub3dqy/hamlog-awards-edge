(() => {
  "use strict";

  const extensionApi = globalThis.browser ?? globalThis.chrome;
  const manifest = extensionApi.runtime.getManifest();
  const project = manifest.homepage_url;
  const repository = new URL(project).pathname.slice(1);
  const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  const zipTypes = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];
  const packages = {
    chromium: {
      name: "hamlog-awards-edge.zip", format: "ZIP", types: zipTypes,
      instructions: "Распакуйте ZIP в папку установленного расширения с заменой файлов. Откройте edge://extensions в Edge или chrome://extensions в Chrome. Нажмите «Перезагрузить» на карточке «Дипломы HAMLOG»."
    },
    firefox: {
      name: "hamlog-awards-firefox.zip", format: "ZIP", types: zipTypes,
      instructions: "Откройте about:debugging#/runtime/this-firefox и выберите ZIP через «Загрузить временное дополнение». Дополнение работает до перезапуска Firefox."
    },
    yandex: {
      name: "hamlog-awards-yandex.crx", format: "CRX", types: ["application/x-chrome-extension", "application/octet-stream"],
      instructions: "Откройте browser://tune и перетащите скачанный CRX в окно Яндекс Браузера."
    }
  };
  let selectedPackage = packages.chromium;
  if (manifest.browser_specific_settings?.gecko?.id === "hamlog-awards@ub3dqy.com") {
    selectedPackage = packages.firefox;
  } else if (manifest.version_name === "Яндекс Браузер") {
    selectedPackage = packages.yandex;
  }
  const cacheKey = "releaseCheck";
  const checkMessage = "hamlog-check-release";

  function parseTag(tag) {
    if (typeof tag !== "string" || !/^v?(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})$/.test(tag)) return null;
    const version = tag.replace(/^v/, "");
    const parts = version.split(".").map(Number);
    return parts.some(part => part > 65535) || parts.every(part => part === 0) ? null : { tag, version, parts };
  }

  function releaseUrl(tag) {
    return `${project}/releases/tag/${tag}`;
  }

  function downloadUrl(tag) {
    return `${project}/releases/download/${tag}/${selectedPackage.name}`;
  }

  function validateRelease(payload) {
    const parsed = parseTag(payload?.tag_name);
    if (!parsed || payload.draft !== false || payload.prerelease !== false || payload.html_url !== releaseUrl(parsed.tag)) {
      return null;
    }

    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const ready = assets.some(asset =>
      asset?.name === selectedPackage.name && asset.state === "uploaded" &&
      Number.isSafeInteger(asset.size) && asset.size > 0 &&
      selectedPackage.types.includes(asset.content_type) &&
      asset.browser_download_url === downloadUrl(parsed.tag)
    );
    return { tag: parsed.tag, ready };
  }

  function view(state) {
    const checkedAt = Number.isSafeInteger(state?.checkedAt) && state.checkedAt > 0 ? state.checkedAt : null;
    const status = checkedAt && ["release", "empty", "error"].includes(state?.status) ? state.status : "pending";
    const installed = parseTag(manifest.version);
    const latest = status === "release" || status === "error" ? parseTag(state?.release?.tag) : null;
    if (!installed || !latest) return { status, checkedAt, installed: manifest.version };

    const different = latest.parts.findIndex((number, index) => number !== installed.parts[index]);
    const available = different !== -1 && latest.parts[different] > installed.parts[different];
    return {
      status, checkedAt, installed: manifest.version, version: latest.version, available,
      release: releaseUrl(latest.tag),
      download: state.release.ready === true ? downloadUrl(latest.tag) : null
    };
  }

  globalThis.hamlogUpdates = Object.freeze({
    project, apiUrl, cacheKey, checkMessage, validateRelease, view,
    instructions: selectedPackage.instructions, packageFormat: selectedPackage.format,
    releases: `${project}/releases`, developer: "https://ub3dqy.com/"
  });
})();
