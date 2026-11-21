"use strict";

importScripts("updates.js");

const { apiUrl, cacheKey, checkMessage, validateRelease, view } = globalThis.hamlogUpdates;
const updateAlarm = "hamlog-github-release";
const checkIntervalMinutes = 24 * 60;
const minimumInterval = 23 * 60 * 60 * 1000;
let pendingCheck;

async function check(force) {
  const { [cacheKey]: previous } = await chrome.storage.local.get(cacheKey);
  const checkedAt = Date.now();
  const age = checkedAt - previous?.checkedAt;
  if (!force && age >= 0 && age < minimumInterval) return previous;

  let state;
  try {
    const response = await fetch(apiUrl, {
      cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10" },
      signal: AbortSignal.timeout(10_000)
    });
    if (response.status === 404) {
      state = { status: "empty", checkedAt };
    } else {
      if (!response.ok) throw new Error("GitHub request failed");
      const release = validateRelease(await response.json());
      if (!release) throw new Error("Unrecognized GitHub release metadata");
      state = { status: "release", checkedAt, release };
    }
  } catch {
    state = { status: "error", checkedAt };
    if (previous?.release) state.release = previous.release;
  }

  await chrome.storage.local.set({ [cacheKey]: state });
  return state;
}

async function checkAndShowBadge(force) {
  const release = view(await check(force));
  await chrome.action.setBadgeText({ text: release.available && release.download ? "↑" : "" });
}

function refresh(force = false) {
  if (!pendingCheck) {
    pendingCheck = checkAndShowBadge(force).finally(() => { pendingCheck = undefined; });
  }
  return pendingCheck;
}

async function ensureAlarm() {
  if (!await chrome.alarms.get(updateAlarm)) {
    await chrome.alarms.create(updateAlarm, { periodInMinutes: checkIntervalMinutes });
  }
}

chrome.runtime.onInstalled.addListener(() => { void refresh().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { void refresh().catch(() => {}); });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === updateAlarm) void refresh().catch(() => {});
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== checkMessage || sender.url !== chrome.runtime.getURL("options.html")) return;
  void refresh(true).then(() => respond({ ok: true }), () => respond({ ok: false }));
  return true;
});

void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
void ensureAlarm().catch(() => {});
