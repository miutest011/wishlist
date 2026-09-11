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

// ---- 所有会变化的状态都放在这里，界面完全由它们决定 ----
// 一条记录长这样：
//   { id, type: 'image' | 'video', mediaId, thumbId, duration, note, createdAt, folderId }
// mediaId 指向原文件，thumbId 指向缩略图，两个都存在 IndexedDB 里。
// folderId 现在永远是 null，是给以后的文件夹功能留的位置
let items = [];
let view = 'grid';        // 现在在哪一页：grid（宫格）/ note（写备注）/ detail（看详情）
let detailId = null;      // 正在看哪一条的详情
let draft = null;         // 正在添加的那一条（还没保存）
let errorText = null;     // 出错时显示在顶部的提示
let importing = false;    // 是不是正在处理刚选中的文件

// 图片和视频的临时地址。key 是文件 id（缩略图用 thumbId，大图用 mediaId，
// 草稿用 'draft'）。存起来复用，否则每次重画都要重新生成，既闪屏又漏内存
let objectUrls = new Map();

function resetViewState() {
  view = 'grid';
  detailId = null;
  draft = null;
  errorText = null;
  importing = false;
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
  });

  return parsed;
}

function saveItems() {
  storage.setItem('items', JSON.stringify(items));
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
      note: ''
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
  draft = null;
  view = 'grid';
  render();
}

// 点「完成」：先把两个文件存进数据库，都成功了才记下这条记录。
// 顺序反过来的话，会出现「记录在、图片打不开」的空白格子
function saveDraft() {
  if (!draft) return Promise.resolve();

  const id = newId();
  const mediaId = 'media-' + id;
  const thumbId = 'thumb-' + id;

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
      folderId: null
    });
    saveItems();

    // 备注页的预览图就是缩略图，直接留着用，省一次读取
    if (objectUrls.has('draft')) {
      objectUrls.set(thumbId, objectUrls.get('draft'));
      objectUrls.delete('draft');
    }

    draft = null;
    view = 'grid';
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
  view = 'grid';
  render();
}

// 备注边打字边存。这里故意不重画页面，否则输入框会失去焦点
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

  items = items.filter((one) => one.id !== id);
  saveItems();
  releaseUrl(item.thumbId);
  releaseUrl(item.mediaId);
  detailId = null;
  view = 'grid';
  render();

  // 记录删了，文件也要删，否则会一直占着空间没人认领
  return Promise.all([
    mediaStore.remove(item.mediaId),
    mediaStore.remove(item.thumbId)
  ]);
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

function render() {
  if (!appEl) return;
  appEl.innerHTML = '';

  if (view === 'note') {
    appEl.appendChild(renderNotePage());
  } else if (view === 'detail') {
    appEl.appendChild(renderDetailPage());
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

// 一张拍立得
function renderCard(item) {
  const card = element('figure', 'card');
  card.style.setProperty('--rot', rotationFor(item.id));
  card.dataset.id = item.id;

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

  card.appendChild(photo);
  card.addEventListener('click', () => openDetail(item.id));
  return card;
}

function renderGridPage() {
  const page = element('div', 'page');

  const bar = element('header', 'topbar');
  const titles = element('div', '');
  titles.appendChild(element('h1', '', '心愿单'));
  titles.appendChild(element('p', 'count', items.length + ' 件种草'));
  bar.appendChild(titles);
  page.appendChild(bar);

  if (items.length === 0) {
    const empty = element('div', 'empty');
    empty.appendChild(element('p', 'empty-title', '还没有种草'));
    empty.appendChild(element('p', 'empty-hint', '点下面的 ＋，从相册里挑一张图或一段视频'));
    page.appendChild(empty);
  } else {
    const wall = element('div', 'wall');
    items.forEach((item) => wall.appendChild(renderCard(item)));
    page.appendChild(wall);
  }

  // 藏起来的选文件输入框。iPhone 上点它会弹出「照片图库 / 拍照 / 选取文件」
  const picker = element('input', 'picker');
  picker.type = 'file';
  picker.accept = 'image/*,video/*';
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const file = picker.files && picker.files[0];
    picker.value = '';   // 清空，这样下次选同一个文件也会触发
    importFile(file);
  });
  page.appendChild(picker);

  const add = button('fab', '', () => picker.click());
  add.setAttribute('aria-label', '添加种草');
  add.appendChild(plusIcon());   // 画出来的加号比「＋」这个字更细、更匀
  page.appendChild(add);
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

  page.appendChild(body);
  return page;
}
