(() => {
  'use strict';

  if (globalThis.hamlogCallsign) return;

  function normalize(value) {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    if (text.length > 64 || !/^[A-Za-z0-9]+(?:(?: *[/-] *| +)[A-Za-z0-9]+)*$/.test(text) ||
        !/[A-Za-z]/.test(text) || !/[0-9]/.test(text)) return null;
    return text.toUpperCase();
  }

  function fileTag(callsign) {
    return callsign.replace(/[ /]+/g, '_');
  }

  globalThis.hamlogCallsign = Object.freeze({ normalize, fileTag });
})();
