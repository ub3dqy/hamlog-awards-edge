(() => {
  "use strict";

  const manifest = chrome.runtime.getManifest();
  const project = manifest.homepage_url;
  const repository = new URL(project).pathname.slice(1);
  const apiUrl = `https://api.github.com/repos/${repository}/releases/latest`;
  const archiveName = "hamlog-awards-edge.zip";
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
    return `${project}/releases/download/${tag}/${archiveName}`;
  }

  function validateRelease(payload) {
    const parsed = parseTag(payload?.tag_name);
    if (!parsed || payload.draft !== false || payload.prerelease !== false || payload.html_url !== releaseUrl(parsed.tag)) {
      return null;
    }

    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    const ready = assets.some(asset =>
      asset?.name === archiveName && asset.state === "uploaded" &&
      Number.isSafeInteger(asset.size) && asset.size > 0 &&
      ["application/zip", "application/x-zip-compressed", "application/octet-stream"].includes(asset.content_type) &&
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
    releases: `${project}/releases`, developer: "https://ub3dqy.com/"
  });
})();
