// 备份：把所有记录、文件夹和媒体文件打包成一个 .zip，以及把它读回来。
//
// 为什么是 zip 而不是一个大 JSON：照片和视频塞进 JSON 要转成 base64，
// 体积会涨三分之一，而且是一坨没法看的文字。zip 在电脑上双击就能打开，
// 里面就是一张张照片 —— 备份的意义本来就是「哪天这个 App 没了，东西还在」。
//
// 项目不装任何依赖，所以 zip 是手写的。只打包、不压缩（method 0）：
// 照片和视频本身已经是压缩过的，再压一遍几乎不会变小，只是白白慢。
//
// 这个文件不碰 IndexedDB 也不碰 localStorage，只做「数据 ⇄ zip」的转换，
// 具体存哪里由 app.js 传进来。这样它好测，以后换成原生 App 也能原样搬走。

const BACKUP_VERSION = 1;
const BACKUP_JSON_NAME = 'wishlist.json';

// ---- CRC-32：zip 要求每个文件都带一个校验码 ----
let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      }
      crcTable[i] = value >>> 0;
    }
  }

  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ---- 写 zip ----
// files: [{ name, bytes }]，bytes 是 Uint8Array
function makeZip(files) {
  const encoder = new TextEncoder();
  const parts = [];        // 拼出来的文件内容
  const central = [];      // 中央目录，zip 靠它来列出里面有什么
  let offset = 0;

  files.forEach((file) => {
    const nameBytes = encoder.encode(file.name);
    const crc = crc32(file.bytes);
    const size = file.bytes.length;

    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);   // 本地文件头的标志
    header.setUint16(4, 20, true);           // 需要 2.0 版本才能解开
    header.setUint16(6, 0x0800, true);       // 文件名是 UTF-8（中文名字才不会乱码）
    header.setUint16(8, 0, true);            // 0 = 不压缩
    header.setUint16(10, 0, true);           // 时间
    header.setUint16(12, 0x21, true);        // 日期：固定写 1980-01-01，
                                             // 这样同样的内容导出两次结果完全一样
    header.setUint32(14, crc, true);
    header.setUint32(18, size, true);
    header.setUint32(22, size, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);

    parts.push(new Uint8Array(header.buffer), nameBytes, file.bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);    // 中央目录条目的标志
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, 0, true);
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, size, true);
    entry.setUint32(24, size, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);       // 这个文件在 zip 里的位置
    central.push(new Uint8Array(entry.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  });

  const centralSize = central.reduce((total, part) => total + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);        // 结尾记录的标志
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);           // 中央目录从哪里开始

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---- 读 zip ----
// 返回 Map：文件名 → Uint8Array
function readZip(blob) {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);

    // 结尾记录在文件末尾，从后往前找
    let end = -1;
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end === -1) throw new Error('这不是一个 zip 文件');

    const count = view.getUint16(end + 10, true);
    let position = view.getUint32(end + 16, true);
    const files = new Map();
    const decoder = new TextDecoder();

    for (let n = 0; n < count; n++) {
      if (view.getUint32(position, true) !== 0x02014b50) throw new Error('这个备份文件坏了');

      const method = view.getUint16(position + 10, true);
      const size = view.getUint32(position + 24, true);
      const nameLength = view.getUint16(position + 28, true);
      const extraLength = view.getUint16(position + 30, true);
      const commentLength = view.getUint16(position + 32, true);
      const localOffset = view.getUint32(position + 42, true);
      const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));

      if (method !== 0) {
        throw new Error('这个备份不是心愿单导出的（里面的文件是压缩过的）');
      }

      // 数据的起点要按本地文件头来算 —— 本地头里的名字和附加字段长度
      // 不一定和中央目录里写的一样
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;

      files.set(name, bytes.subarray(start, start + size));
      position += 46 + nameLength + extraLength + commentLength;
    }

    return files;
  });
}

// 从 MIME 类型猜个扩展名，好让备份在电脑上双击能直接打开
function extensionFor(type) {
  const known = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm'
  };
  return known[type] || 'bin';
}

// ---- 打包 ----
// items / folders 原样写进 JSON；每个文件用 loadFile(id) 取回来。
// 取不到的文件会被跳过，并记在 missing 里 —— 宁可导出一份「少了几张」的备份，
// 也不能因为一个文件坏了就整个导不出来
function buildBackup(options) {
  const items = options.items;
  const folders = options.folders;
  const loadFile = options.loadFile;
  const exportedAt = options.exportedAt || new Date().toISOString();

  const ids = [];
  items.forEach((item) => {
    ids.push(item.mediaId);
    ids.push(item.thumbId);
  });

  const entries = [];
  const missing = [];
  const manifest = {};

  return ids.reduce(
    (chain, id) => chain.then(() => loadFile(id)).then((blob) => {
      if (!blob) {
        missing.push(id);
        return;
      }
      return blob.arrayBuffer().then((buffer) => {
        const name = 'media/' + id + '.' + extensionFor(blob.type);
        manifest[id] = { name: name, type: blob.type || '' };
        entries.push({ name: name, bytes: new Uint8Array(buffer) });
      });
    }),
    Promise.resolve()
  ).then(() => {
    const meta = {
      app: 'wishlist',
      version: BACKUP_VERSION,
      exportedAt: exportedAt,
      items: items,
      folders: folders,
      files: manifest
    };

    entries.unshift({
      name: BACKUP_JSON_NAME,
      bytes: new TextEncoder().encode(JSON.stringify(meta, null, 2))
    });

    return { blob: makeZip(entries), missing: missing, count: items.length };
  });
}

// ---- 解包 ----
// 返回 { items, folders, files: Map(id → Blob) }。
// 认不出来的文件直接报错，别让坏数据混进去
function parseBackup(blob) {
  return readZip(blob).then((files) => {
    const raw = files.get(BACKUP_JSON_NAME);
    if (!raw) throw new Error('这个 zip 里没有心愿单的备份数据');

    let meta;
    try {
      meta = JSON.parse(new TextDecoder().decode(raw));
    } catch (error) {
      throw new Error('备份里的数据读不出来，文件可能坏了');
    }

    if (!meta || meta.app !== 'wishlist' || !Array.isArray(meta.items)) {
      throw new Error('这不是心愿单的备份');
    }
    if (meta.version > BACKUP_VERSION) {
      throw new Error('这份备份是更新版本的心愿单导出的，先更新 App 再恢复');
    }

    const blobs = new Map();
    Object.keys(meta.files || {}).forEach((id) => {
      const record = meta.files[id];
      const bytes = files.get(record.name);
      if (bytes) blobs.set(id, new Blob([bytes], { type: record.type || '' }));
    });

    return {
      items: meta.items,
      folders: Array.isArray(meta.folders) ? meta.folders : [],
      files: blobs,
      exportedAt: meta.exportedAt || ''
    };
  });
}
