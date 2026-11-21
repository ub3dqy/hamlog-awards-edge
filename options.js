"use strict";

const form = document.querySelector("form");
const callsignInput = document.getElementById("callsign");
const saveButton = document.getElementById("save");
const statusLine = document.getElementById("save-status");
const updateButton = document.getElementById("check-updates");
const updateStatus = document.getElementById("update-status");
const downloadLink = document.getElementById("download-update");
const releaseLink = document.getElementById("release-link");
const updateHelp = document.getElementById("update-help");
const updates = globalThis.hamlogUpdates;

async function load() {
  try {
    const { callsign } = await chrome.storage.local.get("callsign");
    callsignInput.value = globalThis.hamlogCallsign.normalize(callsign) || "";
    statusLine.textContent = "";
  } catch {
    statusLine.textContent = "Не удалось прочитать настройки. Введите позывной и сохраните его.";
  } finally {
    callsignInput.disabled = false;
    saveButton.disabled = false;
  }
}

async function save(event) {
  event.preventDefault();
  if (saveButton.disabled) return;

  const callsign = globalThis.hamlogCallsign.normalize(callsignInput.value);
  if (!callsign) {
    callsignInput.setAttribute("aria-invalid", "true");
    statusLine.textContent = "Проверьте позывной. Можно использовать латинские буквы, цифры, пробелы, косую черту и дефис.";
    callsignInput.focus();
    return;
  }

  callsignInput.removeAttribute("aria-invalid");
  saveButton.disabled = true;
  callsignInput.readOnly = true;
  try {
    await chrome.storage.local.set({ callsign });
    callsignInput.value = callsign;
    statusLine.textContent = `Позывной ${callsign} сохранён.`;
  } catch {
    statusLine.textContent = "Не удалось сохранить позывной. Повторите попытку.";
  } finally {
    callsignInput.readOnly = false;
    saveButton.disabled = false;
  }
}

callsignInput.addEventListener("input", () => {
  callsignInput.removeAttribute("aria-invalid");
  statusLine.textContent = "";
});
form.addEventListener("submit", event => void save(event));
void load();

function showUpdate(state) {
  const release = updates.view(state);
  releaseLink.hidden = !release.available;
  downloadLink.hidden = !(release.available && release.download);
  updateHelp.hidden = downloadLink.hidden;
  if (!releaseLink.hidden) releaseLink.href = release.release;
  if (!downloadLink.hidden) downloadLink.href = release.download;

  if (release.status === "error") {
    updateStatus.textContent = release.available
      ? `GitHub сейчас недоступен. Последняя известная версия ${release.version}.`
      : "Не удалось проверить обновления на GitHub. Попробуйте ещё раз позже.";
    return;
  }
  if (release.available) {
    updateStatus.textContent = release.download
      ? `Доступна версия ${release.version}.`
      : `Доступна версия ${release.version}. ZIP для Edge пока отсутствует.`;
  } else if (release.status === "release" && release.version) {
    updateStatus.textContent = "У вас актуальная версия.";
  } else if (release.status === "empty") {
    updateStatus.textContent = "Последний выпуск пока недоступен на GitHub.";
  } else {
    updateStatus.textContent = "Расширение проверяет обновления раз в сутки, пока Edge открыт.";
  }
}

async function readUpdateState() {
  const { [updates.cacheKey]: state } = await chrome.storage.local.get(updates.cacheKey);
  showUpdate(state);
}

document.getElementById("installed-version").textContent = updates.view().installed;
document.getElementById("developer-link").href = updates.developer;
document.getElementById("project-link").href = updates.project;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && updates.cacheKey in changes) showUpdate(changes[updates.cacheKey].newValue);
});
updateButton.addEventListener("click", async () => {
  if (updateButton.disabled) return;
  updateButton.disabled = true;
  updateStatus.textContent = "Проверяю GitHub…";
  try {
    const result = await chrome.runtime.sendMessage({ type: updates.checkMessage });
    if (!result?.ok) throw new Error("Update check unavailable");
    await readUpdateState();
  } catch {
    updateStatus.textContent = "Не удалось проверить обновления. Попробуйте ещё раз позже.";
  } finally {
    updateButton.disabled = false;
  }
});
void readUpdateState().catch(() => {
  updateStatus.textContent = "Не удалось прочитать сведения об обновлениях.";
});
