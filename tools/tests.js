// 所有测试用例。加了新功能之后，在这里补上对应的测试。

// 把「现在」固定成这一刻，和时间有关的判断才有确定答案
const FIXED_NOW = '2026-09-11T10:00:00.000Z';

// ---- 每条测试都用这个开场 ----
// 它准备一份干净的假环境：假存储、假文件仓库、假的缩略图生成，
// 所以测试既不会碰你浏览器里的真实数据，也不用真的去解码图片和视频
function setup(data = {}) {
  const storage = createMemoryStorage();
  if (data.items) storage.setItem('items', JSON.stringify(data.items));
  useStorage(storage);

  const media = data.media || createMemoryMediaStore();
  useMediaStore(media);

  useMediaProcessor(data.processor || fakeProcessor());
  useConfirm(data.confirm || (() => true));
  useNow(() => new Date(FIXED_NOW));

  const root = document.createElement('div');
  document.body.appendChild(root);
  onCleanup(() => root.remove());

  const ready = initApp(root);
  return { root, storage, media, ready };
}

// 假的文件。内容是什么不重要，测试只关心它有没有被存进去
function fakeImageFile(name = 'photo.jpg') {
  return new File(['图片内容'], name, { type: 'image/jpeg' });
}

function fakeVideoFile(name = 'clip.mp4') {
  return new File(['视频内容'], name, { type: 'video/mp4' });
}

// 假的缩略图生成：真的那个要解码图片、截视频帧，测试里跑不了也没必要
function fakeProcessor(overrides = {}) {
  return (file) => {
    const isVideo = (file.type || '').startsWith('video/');
    return Promise.resolve(Object.assign({
      type: isVideo ? 'video' : 'image',
      thumb: new Blob(['缩略图'], { type: 'image/jpeg' }),
      width: 1000,
      height: 1250,
      duration: isVideo ? 34.2 : null
    }, overrides));
  };
}

// 造一条已经存在的记录，外加它的两个文件
function seedItem(media, options = {}) {
  const id = options.id || 'w-1';
  const item = {
    id: id,
    type: options.type || 'image',
    mediaId: 'media-' + id,
    thumbId: 'thumb-' + id,
    duration: options.duration === undefined ? null : options.duration,
    note: options.note || '',
    createdAt: options.createdAt || FIXED_NOW,
    folderId: null
  };
  media.files.set(item.mediaId, new Blob(['原文件'], { type: 'image/jpeg' }));
  media.files.set(item.thumbId, new Blob(['缩略图'], { type: 'image/jpeg' }));
  return item;
}

// ---- 模拟用户操作的小工具 ----
function click(element) {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function typeInto(element, text) {
  element.value = text;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

function textOf(root, selector) {
  const found = root.querySelector(selector);
  return found ? found.textContent : null;
}

function cards(root) {
  return [...root.querySelectorAll('.card')];
}

// ---- 宫格 ----

test('一条记录都没有时，显示空状态和 ＋ 按钮', async () => {
  const { root, ready } = setup();
  await ready;

  assertEqual(textOf(root, '.empty-title'), '还没有种草');
  assertEqual(cards(root).length, 0);
  assert(root.querySelector('.fab'), '应该有 ＋ 按钮');
});

test('已有的记录会画成拍立得，并显示件数', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, ready } = setup({ items, media });
  await ready;

  assertEqual(cards(root).length, 2);
  assertEqual(textOf(root, '.count'), '2 件种草');
  assert(root.querySelector('.card img'), '缩略图应该读出来了');
});

test('视频记录在右下角显示时长，图片没有', async () => {
  const media = createMemoryMediaStore();
  const items = [
    seedItem(media, { id: 'w-video', type: 'video', duration: 34.2 }),
    seedItem(media, { id: 'w-image' })
  ];
  const { root, ready } = setup({ items, media });
  await ready;

  const badges = [...root.querySelectorAll('.badge')];
  assertEqual(badges.length, 1, '只有视频那条该有角标');
  assert(badges[0].textContent.includes('0:34'), '角标上应该写着 0:34，实际是 ' + badges[0].textContent);
});

test('同一条记录歪的角度每次都一样', () => {
  const first = rotationFor('w-123');
  const second = rotationFor('w-123');
  assertEqual(first, second, '每次重画角度都变的话，列表会自己抖');
  assert(first !== rotationFor('w-124'), '不同记录该歪得不一样');
});

// ---- 添加一条 ----

test('选文件的输入框图片和视频都收', async () => {
  const { root, ready } = setup();
  await ready;

  const picker = root.querySelector('input[type="file"]');
  assert(picker, '应该有一个选文件的输入框');
  assertEqual(picker.accept, 'image/*,video/*');
});

test('选完图片先进写备注那一页，还没存下来', async () => {
  const { root, storage, media, ready } = setup();
  await ready;

  await importFile(fakeImageFile());

  assertEqual(textOf(root, '.sheet-title'), '写点备注');
  assert(root.querySelector('.card.preview img'), '应该能看到刚选的那张的预览');
  assertEqual(storage.getItem('items'), null, '没点完成之前不该写进存储');
  assertEqual(media.files.size, 0, '没点完成之前也不该存文件');
});

test('写完备注点完成，宫格里多一条，文件也存进去了', async () => {
  const { root, storage, media, ready } = setup();
  await ready;

  await importFile(fakeImageFile());
  typeInto(root.querySelector('.note-input'), '这个鞋想买');
  await saveDraft();

  assertEqual(cards(root).length, 1);
  const saved = JSON.parse(storage.getItem('items'));
  assertEqual(saved.length, 1);
  assertEqual(saved[0].note, '这个鞋想买');
  assertEqual(saved[0].type, 'image');
  assertEqual(saved[0].createdAt, FIXED_NOW);
  assertEqual(saved[0].folderId, null, 'folderId 要留着，以后做文件夹用');
  assertEqual(media.files.size, 2, '原文件和缩略图都该存进去');
});

test('备注不写也能保存', async () => {
  const { root, storage, ready } = setup();
  await ready;

  await importFile(fakeImageFile());
  await saveDraft();

  assertEqual(cards(root).length, 1);
  assertEqual(JSON.parse(storage.getItem('items'))[0].note, '');
});

test('视频的时长会跟着存下来', async () => {
  const { storage, ready } = setup();
  await ready;

  await importFile(fakeVideoFile());
  await saveDraft();

  const saved = JSON.parse(storage.getItem('items'))[0];
  assertEqual(saved.type, 'video');
  assertEqual(saved.duration, 34.2);
});

test('最新的排在最前面', async () => {
  const media = createMemoryMediaStore();
  const { root, storage, ready } = setup({ items: [seedItem(media, { id: 'w-old' })], media });
  await ready;

  await importFile(fakeImageFile());
  await saveDraft();

  const saved = JSON.parse(storage.getItem('items'));
  assertEqual(saved[1].id, 'w-old', '老的应该被挤到后面');
  assertEqual(cards(root)[1].dataset.id, 'w-old');
});

test('点取消不会留下记录，也不会留下文件', async () => {
  const { root, storage, media, ready } = setup();
  await ready;

  await importFile(fakeImageFile());
  click([...root.querySelectorAll('.text-btn')].find((b) => b.textContent === '取消'));

  assertEqual(textOf(root, '.empty-title'), '还没有种草');
  assertEqual(storage.getItem('items'), null);
  assertEqual(media.files.size, 0);
});

test('文件读不出来时给出提示，不进备注页', async () => {
  const { root, ready } = setup({
    processor: () => Promise.reject(new Error('这个格式不支持'))
  });
  await ready;

  await importFile(fakeImageFile('weird.heic'));

  const banner = root.querySelector('.error-banner');
  assert(banner, '应该有错误提示');
  assert(banner.textContent.includes('这个格式不支持'), '要把原因说出来：' + banner.textContent);
  assertEqual(root.querySelector('.card.preview'), null, '不该进写备注那一页');
});

test('存不下时给出提示，也不会留下半条记录', async () => {
  const media = createMemoryMediaStore();
  let saved = 0;
  media.save = (id, blob) => {
    saved++;
    // 第一个文件存进去了，第二个失败 —— 空间不够时就是这样
    if (saved > 1) return Promise.reject(new Error('空间不足'));
    media.files.set(id, blob);
    return Promise.resolve();
  };

  const { root, storage, ready } = setup({ media });
  await ready;

  await importFile(fakeImageFile());
  await saveDraft();

  assert(root.querySelector('.error-banner'), '应该有错误提示');
  assertEqual(storage.getItem('items'), null, '不该记下这条');
  assertEqual(media.files.size, 0, '已经写进去的那一半要清掉');
});

// ---- 详情 ----

test('点开一条能看到备注和原文件', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1', note: '双十一再看看' })];
  const { root, ready } = setup({ items, media });
  await ready;

  await openDetail('w-1');

  assertEqual(root.querySelector('.note-input').value, '双十一再看看');
  assert(root.querySelector('.detail-media img'), '应该显示原图');
});

test('改了备注会存下来，回到宫格也还在', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1', note: '旧备注' })];
  const { root, storage, ready } = setup({ items, media });
  await ready;

  await openDetail('w-1');
  typeInto(root.querySelector('.note-input'), '改成新的');
  closeDetail();

  assertEqual(JSON.parse(storage.getItem('items'))[0].note, '改成新的');
  await openDetail('w-1');
  assertEqual(root.querySelector('.note-input').value, '改成新的');
});

test('删除会把记录和两个文件一起删掉', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, storage, ready } = setup({ items, media });
  await ready;

  await openDetail('w-1');
  await deleteItem('w-1');

  assertEqual(cards(root).length, 1, '应该回到宫格，只剩一条');
  assertEqual(JSON.parse(storage.getItem('items')).length, 1);
  assertEqual([...media.files.keys()].sort(), ['media-w-2', 'thumb-w-2'], 'w-1 的文件该删干净');
});

test('删除前会问一句，点取消就什么都不动', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' })];
  const { root, ready } = setup({ items, media, confirm: () => false });
  await ready;

  await deleteItem('w-1');

  assertEqual(cards(root).length, 1);
  assertEqual(media.files.size, 2);
});

// ---- 项目本身的检查 ----

// 从 style.css 里把某个选择器下面定义的颜色变量读出来，
// 例如 readTokens(css, '[data-theme="dark"]') → { '--bg': '#0F0F0E', … }
function readTokens(cssText, selector) {
  const start = cssText.indexOf(selector);
  if (start === -1) return null;

  const open = cssText.indexOf('{', start);
  const close = cssText.indexOf('}', open);
  if (open === -1 || close === -1) return null;

  const pairs = [...cssText.slice(open + 1, close).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .map((match) => [match[1], match[2].trim()])
    .sort((a, b) => a[0].localeCompare(b[0]));   // 排序，比较时不受书写顺序影响

  const tokens = {};
  pairs.forEach(([name, value]) => { tokens[name] = value; });
  return tokens;
}

test('深色模式的两份颜色定义完全一致', async () => {
  // 深色的颜色在 style.css 里写了两遍：一份跟随系统，一份给样板页手动指定。
  // 改一处漏一处的话，样板页上看着好好的，真机深色模式里却是坏的
  if (location.protocol === 'file:') skip('本地文件模式读不了项目文件');

  const css = await fetch('../style.css?t=' + Date.now()).then((r) => r.text());
  const followSystem = readTokens(css, ':root:not([data-theme="light"])');
  const forGallery = readTokens(css, '[data-theme="dark"] {');

  assert(followSystem && Object.keys(followSystem).length > 5, '没读到「跟随系统」那份深色定义');
  assertEqual(forGallery, followSystem, '两份深色定义对不上，改颜色时漏了一处');
});

test('＋ 按钮是画出来的图标，并且带无障碍标签', async () => {
  const { root, ready } = setup();
  await ready;

  const fab = root.querySelector('.fab');
  assertEqual(fab.getAttribute('aria-label'), '添加种草');
  assert(fab.querySelector('svg'), '加号应该是画的，不是「＋」这个字');
});

test('index.html 里加载的脚本，sw.js 的缓存列表里都有', async () => {
  // 双击打开测试页时（file://）浏览器不让读项目文件，只能跳过
  if (location.protocol === 'file:') skip('本地文件模式读不了项目文件');

  const [pageText, workerText] = await Promise.all([
    fetch('../index.html?t=' + Date.now()).then((r) => r.text()),
    fetch('../sw.js?t=' + Date.now()).then((r) => r.text())
  ]);

  const scripts = [...pageText.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert(scripts.length > 0, '没找到任何脚本，正则是不是写错了');

  scripts.forEach((src) => {
    assert(
      workerText.includes(`'./${src}'`),
      `index.html 加载了 ${src}，但 sw.js 的缓存列表里没有它 —— 离线时会打不开`
    );
  });
});
