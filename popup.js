"use strict";

const extensionApi = globalThis.browser ?? globalThis.chrome;
const siteOrigin = "https://hamlog.online";
const scanButton = document.getElementById("scan");
const claimButton = document.getElementById("claim");
const downloadButton = document.getElementById("download");
const settingsLink = document.getElementById("settings");
const callsignLine = document.getElementById("callsign");
const statusLine = document.getElementById("status");
const updateNotice = document.getElementById("update-notice");
const updateLink = document.getElementById("update-link");
const updates = globalThis.hamlogUpdates;
const issued = globalThis.hamlogIssuedProgress;
let launchPending = false;
let currentTab;

function setButtonsEnabled(enabled) {
  scanButton.disabled = !enabled;
  claimButton.disabled = !enabled;
  downloadButton.disabled = !enabled;
}

async function getHamlogTab() {
  const [tab] = await extensionApi.tabs.query({ active: true, currentWindow: true });
  if (typeof tab?.id !== "number" || !tab.url) return null;
  return new URL(tab.url).origin === siteOrigin ? tab : null;
}

async function getContext() {
  const [{ callsign }, tab] = await Promise.all([extensionApi.storage.local.get("callsign"), getHamlogTab()]);
  return { callsign: globalThis.hamlogCallsign.normalize(callsign), tab };
}

function showContext(callsign, tab) {
  callsignLine.textContent = callsign || "Позывной не задан";
  if (!callsign) {
    statusLine.textContent = "Укажите свой позывной в настройках расширения.";
  } else if (!tab) {
    statusLine.textContent = "Откройте HAMLOG и войдите в свой кабинет.";
  } else {
    statusLine.textContent = "Ход работы появится на странице HAMLOG.";
  }
}

async function initialize() {
  try {
    const { callsign, tab } = await getContext();
    currentTab = tab;
    showContext(callsign, tab);
    setButtonsEnabled(Boolean(callsign && tab));
  } catch {
    statusLine.textContent = "Не удалось прочитать настройки или проверить вкладку. Откройте панель ещё раз.";
  }
}

async function launch(mode) {
  if (launchPending) return;
  launchPending = true;
  setButtonsEnabled(false);
  statusLine.textContent = "Открываю панель на странице HAMLOG…";

  let canRetry = false;
  try {
    const durable = mode === "download" && !currentTab?.incognito;
    if (durable && !await extensionApi.permissions.request(issued.access).catch(() => false)) {
      statusLine.textContent = "Разрешите доступ к HAMLOG и загрузкам, чтобы расширение могло сохранять прогресс.";
      setButtonsEnabled(true);
      return;
    }
    const { callsign, tab } = await getContext();
    if (!callsign || !tab) {
      showContext(callsign, tab);
      return;
    }
    canRetry = true;
    callsignLine.textContent = callsign;
    if (durable && !tab.incognito) {
      await issued.send("launch", {tabId: tab.id});
      window.close();
      return;
    }

    const target = { tabId: tab.id };
    await extensionApi.scripting.executeScript({
      target,
      files: ["callsign.js", "site-adapter.js", "certificate-archive.js", "issued-progress.js", "runner.js"]
    });
    const [{ result }] = await extensionApi.scripting.executeScript({
      target,
      args: [mode, callsign],
      func: (operation, selectedCallsign) => {
        if (typeof globalThis.hamlogAwards?.run !== "function") return false;
        void globalThis.hamlogAwards.run(operation, selectedCallsign);
        return true;
      }
    });

    if (!result) throw new Error("HAMLOG panel unavailable");
    window.close();
  } catch (error) {
    setButtonsEnabled(canRetry);
    statusLine.textContent = error?.userMessage ||
      "Не удалось запустить помощник. Обновите вкладку HAMLOG и попробуйте ещё раз.";
  } finally {
    launchPending = false;
  }
}

async function openSettings(event) {
  event.preventDefault();
  try {
    await extensionApi.runtime.openOptionsPage();
  } catch {
    statusLine.textContent = "Не удалось открыть настройки расширения.";
  }
}

function showUpdate(state) {
  const release = updates.view(state);
  updateNotice.hidden = !(release.available && release.download);
  if (!updateNotice.hidden) updateLink.textContent = `Доступна версия ${release.version}`;
}

document.getElementById("developer-link").href = updates.developer;
document.getElementById("project-link").href = updates.project;
settingsLink.addEventListener("click", openSettings);
updateLink.addEventListener("click", openSettings);
scanButton.addEventListener("click", () => void launch("scan"));
claimButton.addEventListener("click", () => void launch("claim"));
downloadButton.addEventListener("click", () => void launch("download"));
extensionApi.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && updates.cacheKey in changes) showUpdate(changes[updates.cacheKey].newValue);
});
void extensionApi.storage.local.get(updates.cacheKey).then(data => showUpdate(data[updates.cacheKey]), () => {});
void initialize();
