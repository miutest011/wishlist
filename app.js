// 心愿单的全部界面逻辑。
// 页面（index.html）和测试（tools/test.html）都加载这个文件。
// 文件怎么存、缩略图怎么生成，在 media.js 里，这里只管界面。

// ---- 可替换的外部依赖 ----
// 正常运行时用浏览器真实的存储和弹窗；跑测试时换成假的，
// 这样测试既不会动你的真实数据，也不用真的去解码一张图片。
let storage = window.localStorage;
let mediaStore = createIndexedDbMediaStore('wishlist-media');
let processMediaFn = processMedia;
let confirmFn = (message) => window.confirm(message);
let nowFn = () => new Date();
let appEl = null;

function useStorage(newStorage) {
  storage = newStorage;
}

function useMediaStore(newStore) {
  mediaStore = newStore;
}

function useMediaProcessor(newProcessor) {
  processMediaFn = newProcessor;
}

function useConfirm(newConfirm) {
  confirmFn = newConfirm;
}

function useNow(newNow) {
  nowFn = newNow;
}

// 导出备份时「把文件交给用户」这一步。手机上是系统分享面板，电脑上是下载。
// 测试里换成一个只把文件接住的假函数，免得跑测试时满屏弹下载
let saveFileFn = shareOrDownloadFile;

function useFileSaver(newSaver) {
  saveFileFn = newSaver;
}

// ---- 所有会变化的状态都放在这里，界面完全由它们决定 ----
// 一条记录长这样：
//   { id, type: 'image' | 'video', mediaId, thumbId, duration, note, createdAt, folderId }
// mediaId 指向原文件，thumbId 指向缩略图，两个都存在 IndexedDB 里。
// folderId 是 null 表示还摊在墙上，否则表示收在哪一叠里。
//
// 一个文件夹长这样：
//   { id, name, createdAt, updatedAt }
// updatedAt 是「最后一次往里放东西」的时间，墙上按它排序，刚整理过的那叠会跑到最前面
let items = [];
let folders = [];
let view = 'grid';        // 在哪一页：grid（墙）/ folder（某一叠里）/ note（写备注）/ detail（看详情）
let openFolderId = null;  // 正在看哪一叠
let detailId = null;      // 正在看哪一条的详情
let draft = null;         // 正在添加的那一条（还没保存）
let errorText = null;     // 出错时显示在底部的提示
let importing = false;    // 是不是正在处理刚选中的文件
let backupNote = null;    // 备份页上的结果提示
let backupBusy = false;   // 正在打包或恢复
let storageUsed = null;   // 这个 App 占了多少空间（浏览器给的估算）
let storagePersisted = null;  // 浏览器答没答应「不随便清掉这些数据」

// 图片和视频的临时地址。key 是文件 id（缩略图用 thumbId，大图用 mediaId，
// 草稿用 'draft'）。存起来复用，否则每次重画都要重新生成，既闪屏又漏内存
let objectUrls = new Map();

function resetViewState() {
  view = 'grid';
  openFolderId = null;
  detailId = null;
  draft = null;
  errorText = null;
  importing = false;
  backupNote = null;
  backupBusy = false;
  suppressNextClick = false;
}

// 把所有临时地址还给浏览器
function releaseUrls() {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
}

function releaseUrl(key) {
  if (objectUrls.has(key)) {
    URL.revokeObjectURL(objectUrls.get(key));
    objectUrls.delete(key);
  }
}

// 启动：把应用挂到某个页面元素上，读出记录，画出来。
// 缩略图是异步读的，读到一张画一张，所以这里返回一个 Promise 方便测试等它
function initApp(element) {
  appEl = element;
  releaseUrls();
  resetViewState();
  folders = loadFolders();     // 要先读文件夹，下面校验记录时用得上
  items = loadItems();
  render();
  return loadThumbnails();
}

// ---- 读写记录 ----
function loadItems() {
  const saved = storage.getItem('items');
  const parsed = saved ? JSON.parse(saved) : [];

  // 老数据可能缺字段，补上默认值，免得界面读到 undefined
  parsed.forEach((item) => {
    if (!('note' in item)) item.note = '';
    if (!('duration' in item)) item.duration = null;
    if (!('folderId' in item)) item.folderId = null;
    // 指向一个已经不存在的文件夹时，把它放回墙上。
    // 不这么兜底的话，这条记录哪一页都进不去，等于凭空消失了
    if (item.folderId && !folders.some((folder) => folder.id === item.folderId)) {
      item.folderId = null;
    }
  });

  return parsed;
}

function saveItems() {
  storage.setItem('items', JSON.stringify(items));
}

function loadFolders() {
  const saved = storage.getItem('folders');
  const parsed = saved ? JSON.parse(saved) : [];

  parsed.forEach((folder) => {
    if (!('name' in folder)) folder.name = '';
    if (!('updatedAt' in folder)) folder.updatedAt = folder.createdAt;
  });

  return parsed;
}

function saveFolders() {
  storage.setItem('folders', JSON.stringify(folders));
}

// 把缩略图从数据库里取出来，变成 <img> 能用的地址
function loadThumbnails() {
  const missing = items.filter((item) => !objectUrls.has(item.thumbId));
  if (missing.length === 0) return Promise.resolve();

  const jobs = missing.map((item) => mediaStore.load(item.thumbId).then((blob) => {
    if (blob) objectUrls.set(item.thumbId, URL.createObjectURL(blob));
  }));

  return Promise.all(jobs).then(() => render());
}

function findItem(id) {
  return items.find((item) => item.id === id) || null;
}

function findFolder(id) {
  return folders.find((folder) => folder.id === id) || null;
}

// 某一叠里的照片，保持全局的顺序（最新的在前）
function itemsIn(folderId) {
  return items.filter((item) => item.folderId === folderId);
}

// 还摊在墙上、没归类的照片
function looseItems() {
  return items.filter((item) => item.folderId === null);
}

// 墙上要画的东西：文件夹和没归类的照片混在一起，最新的在前面。
// 文件夹按「最后一次往里放东西」的时间排，所以刚整理过的那叠会浮到最上面
function wallEntries() {
  const entries = folders.map((folder) => ({ kind: 'folder', at: folder.updatedAt, folder: folder }));

  looseItems().forEach((item) => {
    entries.push({ kind: 'item', at: item.createdAt, item: item });
  });

  return entries.sort((a, b) => (a.at < b.at ? 1 : (a.at > b.at ? -1 : 0)));
}

function newId() {
  return 'w-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function messageOf(error) {
  return error && error.message ? error.message : '不知道为什么';
}

// ---- 添加一条 ----

// 选完文件：先生成缩略图，成功了再进「写备注」那一页。
// 这一步可能要几秒（视频尤其慢），所以先把「正在处理」画出来
function importFile(file) {
  if (!file) return Promise.resolve();

  errorText = null;
  importing = true;
  render();

  return processMediaFn(file).then((info) => {
    importing = false;
    draft = {
      file: file,
      type: info.type,
      thumb: info.thumb,
      duration: info.duration === undefined ? null : info.duration,
      note: '',
      // 在某一叠里点的 ＋，就直接加进那一叠
      folderId: view === 'folder' ? openFolderId : null
    };
    objectUrls.set('draft', URL.createObjectURL(info.thumb));
    view = 'note';
    render();
  }).catch((error) => {
    importing = false;
    errorText = '这个文件没能读出来：' + messageOf(error);
    render();
  });
}

function cancelDraft() {
  releaseUrl('draft');
  const backTo = draft && draft.folderId ? 'folder' : 'grid';
  draft = null;
  view = backTo;
  render();
}

// 点「完成」：先把两个文件存进数据库，都成功了才记下这条记录。
// 顺序反过来的话，会出现「记录在、图片打不开」的空白格子
function saveDraft() {
  if (!draft) return Promise.resolve();

  const id = newId();
  const mediaId = 'media-' + id;
  const thumbId = 'thumb-' + id;
  const folderId = draft.folderId;

  return Promise.all([
    mediaStore.save(mediaId, draft.file),
    mediaStore.save(thumbId, draft.thumb)
  ]).then(() => {
    items.unshift({           // 最新的排在最前面
      id: id,
      type: draft.type,
      mediaId: mediaId,
      thumbId: thumbId,
      duration: draft.duration,
      note: draft.note.trim(),
      createdAt: nowFn().toISOString(),
      folderId: folderId
    });
    saveItems();

    if (folderId) {
      touchFolder(folderId);
      saveFolders();
    }

    // 备注页的预览图就是缩略图，直接留着用，省一次读取
    if (objectUrls.has('draft')) {
      objectUrls.set(thumbId, objectUrls.get('draft'));
      objectUrls.delete('draft');
    }

    draft = null;
    view = folderId ? 'folder' : 'grid';
    render();
  }).catch((error) => {
    // 最常见的是本机空间不够（视频很容易撑爆）
    errorText = '没存下来：' + messageOf(error) + '。可能是手机空间不够了。';
    render();
    // 可能已经写进去一半，清掉，免得留下没人认领的文件白占空间
    return Promise.all([
      mediaStore.remove(mediaId),
      mediaStore.remove(thumbId)
    ]).catch(() => undefined);
  });
}

// ---- 文件夹 ----

function touchFolder(folderId) {
  const folder = findFolder(folderId);
  if (folder) folder.updatedAt = nowFn().toISOString();
}

// 空文件夹自动消失 —— 墙上留一个空叠没有任何意义，
// 还得专门做个「删文件夹」的操作才能清掉
function dropEmptyFolder(folderId) {
  if (!folderId) return;
  if (itemsIn(folderId).length > 0) return;

  folders = folders.filter((folder) => folder.id !== folderId);
  if (openFolderId === folderId) {
    openFolderId = null;
    if (view === 'folder') view = 'grid';
  }
}

// 把一条记录放进某一叠（folderId 传 null 就是移回墙上）
function moveToFolder(itemId, folderId) {
  const item = findItem(itemId);
  if (!item) return;

  const from = item.folderId;
  item.folderId = folderId;
  saveItems();

  touchFolder(folderId);
  dropEmptyFolder(from);
  saveFolders();
  render();
}

// 拖到别的东西上松手时调用。
// 拖到另一张照片上 → 两张合成新的一叠；拖到一叠上 → 放进去。
// 返回落进了哪个文件夹，没成功就返回 null
function dropOnto(sourceItemId, targetId) {
  const source = findItem(sourceItemId);
  if (!source) return null;

  const folder = findFolder(targetId);
  if (folder) {
    moveToFolder(source.id, folder.id);
    return folder.id;
  }

  const target = findItem(targetId);
  if (!target || target.id === source.id) return null;
  // 只有都还摊在墙上的两张才合并。只要有一张已经收在某一叠里就不动 ——
  // 否则叠里的两张一拖又能套出一个新文件夹，越理越乱
  if (source.folderId !== null || target.folderId !== null) return null;

  const created = {
    id: 'f-' + newId(),
    name: '',
    createdAt: nowFn().toISOString(),
    updatedAt: nowFn().toISOString()
  };
  folders.unshift(created);

  target.folderId = created.id;
  source.folderId = created.id;
  saveItems();
  saveFolders();

  // 直接进到新的一叠里，让你顺手起个名字
  openFolderId = created.id;
  view = 'folder';
  render();
  return created.id;
}

function openFolder(folderId) {
  if (!findFolder(folderId)) return;
  openFolderId = folderId;
  view = 'folder';
  render();
}

function closeFolder() {
  openFolderId = null;
  view = 'grid';
  render();
}

// 边打字边存。这里故意不重画页面，否则输入框会失去焦点
function renameFolder(folderId, name) {
  const folder = findFolder(folderId);
  if (!folder) return;
  folder.name = name.trim();
  saveFolders();
}

// ---- 看详情、改备注、删除 ----
function openDetail(id) {
  const item = findItem(id);
  if (!item) return Promise.resolve();

  detailId = id;
  view = 'detail';
  render();

  if (objectUrls.has(item.mediaId)) return Promise.resolve();

  return mediaStore.load(item.mediaId).then((blob) => {
    if (blob) {
      objectUrls.set(item.mediaId, URL.createObjectURL(blob));
      render();
    }
  });
}

function closeDetail() {
  const item = findItem(detailId);
  // 大图（尤其是视频）挺占内存的，离开详情页就还回去，缩略图留着
  if (item) releaseUrl(item.mediaId);
  detailId = null;
  view = openFolderId ? 'folder' : 'grid';   // 从哪一叠点进来的就回哪一叠
  render();
}

function setNote(id, text) {
  const item = findItem(id);
  if (!item) return;
  item.note = text;
  saveItems();
}

function deleteItem(id) {
  const item = findItem(id);
  if (!item) return Promise.resolve();
  if (!confirmFn('删掉这条种草？相册里要是已经删了，就找不回来了。')) {
    return Promise.resolve();
  }

  const from = item.folderId;
  items = items.filter((one) => one.id !== id);
  saveItems();
  releaseUrl(item.thumbId);
  releaseUrl(item.mediaId);

  dropEmptyFolder(from);
  saveFolders();

  detailId = null;
  view = openFolderId ? 'folder' : 'grid';
  render();

  // 记录删了，文件也要删，否则会一直占着空间没人认领
  return Promise.all([
    mediaStore.remove(item.mediaId),
    mediaStore.remove(item.thumbId)
  ]);
}

// ---- 备份 ----

// 把打包好的文件交给用户。
// iPhone 上用系统分享面板（里面有「存储到文件」，能存进 iCloud Drive）；
// 电脑上没有分享面板，退回成普通下载
function shareOrDownloadFile(blob, filename) {
  const file = new File([blob], filename, { type: 'application/zip' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: filename }).catch((error) => {
      if (error && error.name === 'AbortError') return;   // 用户自己点了取消，不算出错
      throw error;
    });
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);   // 等下载真正开始了再回收
  return Promise.resolve();
}

function backupFileName() {
  const now = nowFn();
  const pad = (n) => String(n).padStart(2, '0');
  return `心愿单备份-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.zip`;
}

function openBackup() {
  view = 'backup';
  backupNote = null;
  render();
  return refreshStorageInfo();
}

function closeBackup() {
  view = 'grid';
  backupNote = null;
  render();
}

// 占了多少空间、系统答没答应别清掉。两个都是问浏览器要的，拿不到就不显示
function refreshStorageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve();

  return navigator.storage.estimate()
    .then((estimate) => {
      storageUsed = estimate && estimate.usage ? estimate.usage : 0;
      return navigator.storage.persisted ? navigator.storage.persisted() : null;
    })
    .then((persisted) => {
      storagePersisted = persisted;
      render();
    })
    .catch(() => undefined);
}

function exportBackup() {
  backupBusy = true;
  backupNote = null;
  render();

  return buildBackup({
    items: items,
    folders: folders,
    loadFile: (id) => mediaStore.load(id),
    exportedAt: nowFn().toISOString()
  }).then((result) => {
    return Promise.resolve(saveFileFn(result.blob, backupFileName())).then(() => result);
  }).then((result) => {
    backupBusy = false;
    backupNote = result.missing.length > 0
      ? `打包了 ${result.count} 条，其中 ${result.missing.length} 个文件没找到（那几条的照片可能早就坏了）`
      : `打包了 ${result.count} 条。存好之后，相册里的原件就可以删了`;
    render();
  }).catch((error) => {
    backupBusy = false;
    backupNote = '导出失败：' + messageOf(error);
    render();
  });
}

// 恢复是「合并」不是「覆盖」：已经有的记录跳过。
// 这样误点两次不会重复，也绝不会把现有的东西冲掉
function importBackup(file) {
  if (!file) return Promise.resolve();

  backupBusy = true;
  backupNote = null;
  render();

  return parseBackup(file).then((backup) => {
    const existing = new Set(items.map((item) => item.id));
    const incoming = backup.items.filter((item) => !existing.has(item.id));

    // 先把文件写进去，成功了再记录 —— 顺序反过来会出现「有记录、打不开」的空白格子
    const jobs = [];
    incoming.forEach((item) => {
      const media = backup.files.get(item.mediaId);
      const thumb = backup.files.get(item.thumbId);
      if (media) jobs.push(mediaStore.save(item.mediaId, media));
      if (thumb) jobs.push(mediaStore.save(item.thumbId, thumb));
    });

    return Promise.all(jobs).then(() => {
      const known = new Set(folders.map((folder) => folder.id));
      backup.folders.forEach((folder) => {
        if (!known.has(folder.id)) folders.push(folder);
      });

      items = items.concat(incoming);
      items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : (a.createdAt > b.createdAt ? -1 : 0)));
      saveItems();
      saveFolders();

      backupBusy = false;
      const skipped = backup.items.length - incoming.length;
      if (incoming.length === 0) {
        backupNote = '这份备份里的东西都已经在了，没有重复导入';
      } else {
        backupNote = `恢复了 ${incoming.length} 条` + (skipped > 0 ? `，跳过 ${skipped} 条已经有的` : '');
      }
      render();
      return loadThumbnails();
    });
  }).catch((error) => {
    backupBusy = false;
    backupNote = '恢复失败：' + messageOf(error);
    render();
  });
}

// ---- 拖拽：把一张拖到另一张上归到一叠 ----
// 用指针事件自己实现，因为浏览器自带的 HTML5 拖拽在手机上完全不工作。
// 手感仿的是 iPhone 桌面挪 App：手机上按住约半秒浮起来跟着手指走，
// 电脑上按住鼠标挪一点就开始拖，不用等。
// 浮起来的是一个副本（ghost），原来那张留在原地变淡当占位。

let longPressDelay = 450;        // 触屏上按住多久开始拖
const MOVE_THRESHOLD = 8;        // 移动超过这么多像素就不算「按住不动」了
const EDGE_SIZE = 70;            // 拖到离屏幕边缘这么近时自动滚动
const EDGE_SPEED = 12;
let suppressNextClick = false;   // 刚拖完紧跟着的那次点击要忽略掉

function useLongPressDelay(ms) {  // 测试时改成 0，免得每条测试都要等半秒
  longPressDelay = ms;
}

function autoScroll(pointerY) {
  if (pointerY < EDGE_SIZE) {
    window.scrollBy(0, -EDGE_SPEED);
  } else if (pointerY > window.innerHeight - EDGE_SIZE) {
    window.scrollBy(0, EDGE_SPEED);
  }
}

// 指针下面是哪个可以接住的东西。ghost 设了 pointer-events: none，
// 所以这里不会拿到那个跟着手指走的副本
function dropTargetAt(x, y) {
  const under = document.elementFromPoint(x, y);
  const card = under && under.closest ? under.closest('[data-drop-id]') : null;
  return card || null;
}

function makeDraggable(card, itemId) {
  card.addEventListener('pointerdown', (event) => {
    if (event.button > 0) return;   // 只响应左键

    const startX = event.clientX;
    const startY = event.clientY;
    const isTouch = event.pointerType !== 'mouse';

    let dragging = false;
    let ghost = null;
    let timer = null;
    let hovered = null;

    function beginDrag() {
      timer = null;
      dragging = true;

      const rect = card.getBoundingClientRect();
      ghost = card.cloneNode(true);
      ghost.classList.add('drag-ghost');
      ghost.style.width = rect.width + 'px';
      ghost.style.left = rect.left + 'px';
      ghost.style.top = rect.top + 'px';
      document.body.appendChild(ghost);

      card.classList.add('drag-source');
    }

    function cancelLongPress() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function highlight(target) {
      if (hovered === target) return;
      if (hovered) hovered.classList.remove('drop-target');
      hovered = target;
      if (hovered) hovered.classList.add('drop-target');
    }

    if (isTouch) {
      timer = setTimeout(beginDrag, longPressDelay);
    }

    function onPointerMove(moveEvent) {
      const distance = Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY);

      if (!dragging) {
        if (isTouch) {
          // 长按还没到就滑动了，说明用户是想滚页面，别抢
          if (distance > MOVE_THRESHOLD) cancelLongPress();
          return;
        }
        if (distance <= MOVE_THRESHOLD) return;
        // 鼠标不用等长按：动一下就开始拖，这一次移动也要立刻算数，
        // 不然手感上会「迟钝一下才跟上」
        beginDrag();
      }

      ghost.style.transform =
        `translate(${moveEvent.clientX - startX}px, ${moveEvent.clientY - startY}px) scale(1.06)`;
      autoScroll(moveEvent.clientY);

      const target = dropTargetAt(moveEvent.clientX, moveEvent.clientY);
      highlight(target && target.dataset.dropId !== itemId ? target : null);
    }

    // 拖动过程中要拦住页面滚动。
    // 这个监听必须写成 passive: false，否则浏览器不许我们拦
    function onTouchMove(touchEvent) {
      if (dragging) touchEvent.preventDefault();
    }

    function onPointerUp() {
      cancelLongPress();
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('touchmove', onTouchMove);

      if (!dragging) return;      // 只是点了一下，交给点击事件去处理

      ghost.remove();
      card.classList.remove('drag-source');
      const target = hovered;
      highlight(null);

      // 刚拖完紧接着会来一个 click，要拦掉，否则会误进详情页
      suppressNextClick = true;

      if (target) dropOnto(itemId, target.dataset.dropId);
    }

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
  });
}

// ---- 画面 ----

// 每张拍立得歪的角度。用 id 算出来，所以同一条记录每次显示都歪得一样 ——
// 每次重画都随机的话，翻一下列表照片就自己动了，很晃眼
function rotationFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) % 100000;
  }
  return ((hash % 51) / 10 - 2.5).toFixed(1) + 'deg';   // -2.5 ~ +2.5 度
}

// 1536000 → 1.5 MB
function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// 2026-09-11T… → 9月11日
function formatDate(isoText) {
  const date = new Date(isoText);
  return (date.getMonth() + 1) + '月' + date.getDate() + '日';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 悬浮按钮上的加号。用画的而不是打「＋」这个字，
// 因为字体里的加号又粗又不居中，放大了很明显
function plusIcon() {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('aria-hidden', 'true');

  const path = document.createElementNS(namespace, 'path');
  path.setAttribute('d', 'M12 5.5v13M5.5 12h13');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.6');
  path.setAttribute('stroke-linecap', 'round');

  svg.appendChild(path);
  return svg;
}

function button(className, text, onClick) {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

// 点一下。刚拖完的那次点击要吞掉，否则松手就误进详情页
function onTap(node, handler) {
  node.addEventListener('click', () => {
    if (suppressNextClick) {
      suppressNextClick = false;
      return;
    }
    handler();
  });
}

function render() {
  if (!appEl) return;
  appEl.innerHTML = '';

  if (view === 'note') {
    appEl.appendChild(renderNotePage());
  } else if (view === 'detail') {
    appEl.appendChild(renderDetailPage());
  } else if (view === 'folder') {
    appEl.appendChild(renderFolderPage());
  } else if (view === 'backup') {
    appEl.appendChild(renderBackupPage());
  } else {
    appEl.appendChild(renderGridPage());
  }

  if (errorText) appEl.appendChild(renderError());
  if (importing) appEl.appendChild(renderBusy());
}

function renderError() {
  const box = element('div', 'error-banner');
  box.appendChild(element('span', '', errorText));
  box.appendChild(button('error-close', '知道了', () => {
    errorText = null;
    render();
  }));
  return box;
}

function renderBusy() {
  const box = element('div', 'busy');
  box.appendChild(element('div', 'busy-card', '正在处理……'));
  return box;
}

// 照片本身（相框里的那一格）
function renderPhoto(item) {
  const photo = element('div', 'photo');

  const url = objectUrls.get(item.thumbId);
  if (url) {
    const image = element('img');
    image.src = url;
    image.alt = item.note || '一条种草';
    photo.appendChild(image);
  }

  if (item.type === 'video') {
    const badge = element('span', 'badge');
    badge.appendChild(element('span', 'badge-play', '▶'));
    badge.appendChild(element('span', '', formatDuration(item.duration)));
    photo.appendChild(badge);
  }

  return photo;
}

// 一张拍立得。draggable 为真时可以拖到别的东西上归类
function renderCard(item, draggable) {
  const card = element('figure', 'card');
  card.style.setProperty('--rot', rotationFor(item.id));
  card.dataset.id = item.id;
  card.dataset.dropId = item.id;      // 别的照片可以拖到它上面

  card.appendChild(renderPhoto(item));
  onTap(card, () => openDetail(item.id));
  if (draggable) makeDraggable(card, item.id);
  return card;
}

// 一叠。后面垫两张纸，最上面那张是这叠里最新的照片，名字写在下方白边上
function renderFolderCard(folder) {
  const inside = itemsIn(folder.id);

  const stack = element('div', 'folder-stack');
  stack.dataset.dropId = folder.id;   // 照片可以直接拖进这一叠
  stack.dataset.folderId = folder.id;
  stack.style.setProperty('--rot', rotationFor(folder.id));

  stack.appendChild(element('div', 'stack-sheet stack-sheet-back'));
  stack.appendChild(element('div', 'stack-sheet stack-sheet-mid'));

  const card = element('figure', 'card card-folder');
  card.appendChild(inside.length > 0 ? renderPhoto(inside[0]) : element('div', 'photo'));

  const caption = element('figcaption', 'folder-caption');
  if (folder.name) caption.appendChild(element('span', 'folder-name', folder.name));
  caption.appendChild(element('span', 'folder-count', inside.length + ' 张'));
  card.appendChild(caption);

  stack.appendChild(card);
  onTap(stack, () => openFolder(folder.id));
  return stack;
}

// 藏起来的选文件输入框。iPhone 上点它会弹出「照片图库 / 拍照 / 选取文件」
function renderPicker() {
  const picker = element('input', 'picker');
  picker.type = 'file';
  picker.accept = 'image/*,video/*';
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';   // 清空，这样下次选同一个文件也会触发
    importFile(file);
  });
  return picker;
}

function renderAddButton(picker) {
  const add = button('fab', '', () => picker.click());
  add.setAttribute('aria-label', '添加种草');
  add.appendChild(plusIcon());   // 画出来的加号比「＋」这个字更细、更匀
  return add;
}

function renderGridPage() {
  const page = element('div', 'page');

  const bar = element('header', 'topbar');
  const titles = element('div', '');
  titles.appendChild(element('h1', '', '心愿单'));
  titles.appendChild(element('p', 'count', items.length + ' 件种草'));
  bar.appendChild(titles);
  bar.appendChild(button('backup-entry', '备份', openBackup));
  page.appendChild(bar);

  const entries = wallEntries();
  if (entries.length === 0) {
    const empty = element('div', 'empty');
    empty.appendChild(element('p', 'empty-title', '还没有种草'));
    empty.appendChild(element('p', 'empty-hint', '点下面的 ＋，从相册里挑一张图或一段视频'));
    page.appendChild(empty);
  } else {
    const wall = element('div', 'wall');
    entries.forEach((entry) => {
      wall.appendChild(entry.kind === 'folder'
        ? renderFolderCard(entry.folder)
        : renderCard(entry.item, true));
    });
    page.appendChild(wall);
  }

  const picker = renderPicker();
  page.appendChild(picker);
  page.appendChild(renderAddButton(picker));
  return page;
}

// 某一叠里面。这里不能再拖 —— 不做文件夹套文件夹，越套越乱
function renderFolderPage() {
  const folder = findFolder(openFolderId);
  if (!folder) {
    view = 'grid';
    return renderGridPage();
  }

  const page = element('div', 'page');

  const bar = element('header', 'sheet-bar');
  bar.appendChild(button('text-btn', '返回', closeFolder));

  const name = element('input', 'folder-name-input');
  name.type = 'text';
  name.value = folder.name;
  name.placeholder = '给这一叠起个名字';
  name.setAttribute('aria-label', '文件夹名字');
  name.addEventListener('input', () => renameFolder(folder.id, name.value));
  bar.appendChild(name);

  bar.appendChild(element('span', 'folder-count-badge', itemsIn(folder.id).length + ' 张'));
  page.appendChild(bar);

  const wall = element('div', 'wall');
  itemsIn(folder.id).forEach((item) => wall.appendChild(renderCard(item, false)));
  page.appendChild(wall);

  const picker = renderPicker();
  page.appendChild(picker);
  page.appendChild(renderAddButton(picker));
  return page;
}

function renderBackupPage() {
  const page = element('div', 'page sheet');

  const bar = element('header', 'sheet-bar');
  bar.appendChild(button('text-btn', '返回', closeBackup));
  bar.appendChild(element('span', 'sheet-title', '备份'));
  bar.appendChild(element('span', 'folder-count-badge', ''));   // 占位，让标题居中
  page.appendChild(bar);

  const body = element('div', 'sheet-body');

  body.appendChild(element(
    'p',
    'hint',
    '照片和视频是复制进这个 App 的，相册里删掉之后，这里就是唯一的一份。' +
    '导出一份备份存到「文件」App 或 iCloud Drive，才算真的保住了。'
  ));

  const exportBlock = element('div', 'backup-block');
  exportBlock.appendChild(element('h2', '', '导出备份'));
  exportBlock.appendChild(element(
    'p',
    'hint',
    '打包成一个 zip：所有照片、视频、备注和文件夹都在里面。' +
    '在电脑上双击就能打开，里面就是一张张照片。'
  ));
  const exportButton = button('action-btn primary', backupBusy ? '正在处理……' : '导出 ' + items.length + ' 条', exportBackup);
  exportButton.disabled = backupBusy || items.length === 0;
  exportBlock.appendChild(exportButton);
  body.appendChild(exportBlock);

  const importBlock = element('div', 'backup-block');
  importBlock.appendChild(element('h2', '', '从备份恢复'));
  importBlock.appendChild(element(
    'p',
    'hint',
    '选一个之前导出的 zip。已经有的记录会自动跳过，不会重复，也不会覆盖现在的东西。'
  ));

  const picker = element('input', 'backup-picker');
  picker.type = 'file';
  picker.accept = '.zip,application/zip';
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';
    importBackup(file);
  });
  importBlock.appendChild(picker);

  const importButton = button('action-btn', '选择备份文件', () => picker.click());
  importButton.disabled = backupBusy;
  importBlock.appendChild(importButton);
  body.appendChild(importBlock);

  if (backupNote) body.appendChild(element('p', 'backup-status', backupNote));

  if (storageUsed !== null) {
    const persisted = storagePersisted === true
      ? '系统已经答应不随便清掉这些数据'
      : '系统还没答应「不随便清掉这些数据」，更要留一份备份';
    body.appendChild(element('p', 'hint', '现在占用 ' + formatSize(storageUsed) + ' · ' + persisted));
  }

  page.appendChild(body);
  return page;
}

function renderNotePage() {
  const page = element('div', 'page sheet');

  const bar = element('header', 'sheet-bar');
  bar.appendChild(button('text-btn', '取消', cancelDraft));
  bar.appendChild(element('span', 'sheet-title', '写点备注'));
  bar.appendChild(button('text-btn primary', '完成', saveDraft));
  page.appendChild(bar);

  const body = element('div', 'sheet-body');

  const card = element('figure', 'card preview');
  card.style.setProperty('--rot', '-1.5deg');
  const photo = element('div', 'photo');
  const url = objectUrls.get('draft');
  if (url) {
    const image = element('img');
    image.src = url;
    image.alt = '刚选的';
    photo.appendChild(image);
  }
  if (draft.type === 'video') {
    const badge = element('span', 'badge');
    badge.appendChild(element('span', 'badge-play', '▶'));
    badge.appendChild(element('span', '', formatDuration(draft.duration)));
    photo.appendChild(badge);
  }
  card.appendChild(photo);
  body.appendChild(card);

  const input = element('textarea', 'note-input');
  input.placeholder = '想说点什么？不写也行';
  input.value = draft.note;
  input.addEventListener('input', () => {
    draft.note = input.value;   // 故意不重画，否则输入框会失去焦点
  });
  body.appendChild(input);

  body.appendChild(element(
    'p',
    'hint',
    (draft.type === 'video' ? '视频' : '图片') + ' · ' + formatSize(draft.file.size) +
    ' · 点完成后会存进这个 App，相册里就可以删掉了'
  ));

  page.appendChild(body);
  return page;
}

function renderDetailPage() {
  const item = findItem(detailId);
  if (!item) {
    view = 'grid';
    return renderGridPage();
  }

  const page = element('div', 'page sheet');

  const bar = element('header', 'sheet-bar');
  bar.appendChild(button('text-btn', '返回', closeDetail));
  bar.appendChild(element('span', 'sheet-title', formatDate(item.createdAt)));
  bar.appendChild(button('text-btn danger', '删除', () => deleteItem(item.id)));
  page.appendChild(bar);

  const body = element('div', 'sheet-body');

  const stage = element('div', 'detail-media');
  const url = objectUrls.get(item.mediaId);
  if (url && item.type === 'video') {
    const video = element('video');
    video.src = url;
    video.controls = true;
    video.playsInline = true;
    stage.appendChild(video);
  } else if (url) {
    const image = element('img');
    image.src = url;
    image.alt = item.note || '一条种草';
    stage.appendChild(image);
  } else {
    stage.appendChild(element('p', 'hint', '正在打开……'));
  }
  body.appendChild(stage);

  const input = element('textarea', 'note-input');
  input.placeholder = '加点备注';
  input.value = item.note;
  input.addEventListener('input', () => setNote(item.id, input.value));
  body.appendChild(input);

  const meta = item.type === 'video'
    ? '视频 · ' + formatDuration(item.duration)
    : '图片';
  body.appendChild(element('p', 'hint', formatDate(item.createdAt) + '添加 · ' + meta));

  // 收在某一叠里的时候，给一个拿出来的口子。
  // 手机上把一张从叠里拖出来很难拖准，做成按钮更稳
  if (item.folderId) {
    const folder = findFolder(item.folderId);
    const actions = element('div', 'row-actions');
    actions.appendChild(button('text-link', '移出「' + (folder && folder.name ? folder.name : '这一叠') + '」', () => {
      moveToFolder(item.id, null);
      closeDetail();
    }));
    body.appendChild(actions);
  }

  page.appendChild(body);
  return page;
}
