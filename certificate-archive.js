(() => {
  "use strict";

  if (globalThis.hamlogCertificateArchive) return;

  const maxEntries = 0xfffe;
  const maxArchiveSize = 0xfffffffe;
  const utf8Flag = 0x0800;
  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);

  for (let index = 0; index < crcTable.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    crcTable[index] = crc;
  }

  function safeName(input, suffixByName) {
    const trimmed = String(input ?? "")
      .normalize("NFC")
      .replace(/[<>:"\/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "_")
      .replace(/^[.\s]+|[.\s]+$/gu, "");
    const name = trimmed || "Диплом";
    const lastDot = name.lastIndexOf(".");
    const extension = lastDot > 0 ? Array.from(name.slice(lastDot)).slice(0, 16).join("") : "";
    let stem = lastDot > 0 ? name.slice(0, lastDot) : name;
    if (/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])\s*(?:\.|$)/iu.test(stem)) {
      stem = "_" + stem;
    }
    stem = Array.from(stem).slice(0, 120).join("").replace(/[.\s]+$/gu, "") || "Диплом";

    let result = stem + extension;
    const key = result.toLowerCase();
    if (suffixByName.has(key)) {
      let suffix = suffixByName.get(key);
      do {
        result = stem + " (" + suffix + ")" + extension;
        suffix += 1;
      } while (suffixByName.has(result.toLowerCase()));
      suffixByName.set(key, suffix);
    }
    suffixByName.set(result.toLowerCase(), 2);
    return encoder.encode(result);
  }

  async function checksum(blob) {
    let crc = 0xffffffff;
    const reader = blob.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const byte of value) {
          crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
        }
      }
    } finally {
      reader.releaseLock();
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function localHeader(entry, crc, date, time) {
    const bytes = new Uint8Array(30 + entry.name.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, utf8Flag, true);
    view.setUint16(10, time, true);
    view.setUint16(12, date, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.blob.size, true);
    view.setUint32(22, entry.blob.size, true);
    view.setUint16(26, entry.name.length, true);
    bytes.set(entry.name, 30);
    return bytes;
  }

  function directoryEntry(entry, crc, date, time) {
    const bytes = new Uint8Array(46 + entry.name.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, utf8Flag, true);
    view.setUint16(12, time, true);
    view.setUint16(14, date, true);
    view.setUint32(16, crc, true);
    view.setUint32(20, entry.blob.size, true);
    view.setUint32(24, entry.blob.size, true);
    view.setUint16(28, entry.name.length, true);
    view.setUint32(42, entry.offset, true);
    bytes.set(entry.name, 46);
    return bytes;
  }

  async function create(files) {
    const entries = [];
    const suffixByName = new Map();
    let localSize = 0;
    let directorySize = 0;

    for (const { blob, filename } of files) {
      if (!(blob instanceof Blob)) throw new TypeError("В архив можно добавить только файлы.");
      if (entries.length === maxEntries) throw new RangeError("Слишком много файлов для одного ZIP-архива.");
      const name = safeName(filename, suffixByName);
      const offset = localSize;
      localSize += 30 + name.length + blob.size;
      directorySize += 46 + name.length;
      if (localSize + directorySize + 22 > maxArchiveSize) {
        throw new RangeError("Слишком большой размер файлов для одного ZIP-архива.");
      }
      entries.push({ blob, name, offset });
    }

    const now = new Date();
    const year = Math.max(1980, Math.min(2107, now.getFullYear()));
    const date = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >>> 1);
    const localParts = [];
    const directoryParts = [];
    for (const entry of entries) {
      const crc = await checksum(entry.blob);
      localParts.push(localHeader(entry, crc, date, time), entry.blob);
      directoryParts.push(directoryEntry(entry, crc, date, time));
    }

    const end = new Uint8Array(22);
    const view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, entries.length, true);
    view.setUint16(10, entries.length, true);
    view.setUint32(12, directorySize, true);
    view.setUint32(16, localSize, true);
    return new Blob([...localParts, ...directoryParts, end], { type: "application/zip" });
  }

  globalThis.hamlogCertificateArchive = Object.freeze({ create });
})();
