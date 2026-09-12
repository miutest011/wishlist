// 所有测试用例。加了新功能之后，在这里补上对应的测试。

// 把「现在」固定成这一刻，和时间有关的判断才有确定答案
const FIXED_NOW = '2026-09-11T10:00:00.000Z';

// ---- 每条测试都用这个开场 ----
// 它准备一份干净的假环境：假存储、假文件仓库、假的缩略图生成，
// 所以测试既不会碰你浏览器里的真实数据，也不用真的去解码图片和视频
function setup(data = {}) {
  const storage = createMemoryStorage();
  if (data.items) storage.setItem('items', JSON.stringify(data.items));
  if (data.folders) storage.setItem('folders', JSON.stringify(data.folders));
  useStorage(storage);
  useLongPressDelay(450);   // 恢复默认，免得某条测试改过之后泄漏给后面的测试

  const media = data.media || createMemoryMediaStore();
  useMediaStore(media);

  useMediaProcessor(data.processor || fakeProcessor());
  useConfirm(data.confirm || (() => true));
  useNow(() => new Date(FIXED_NOW));
  // 导出时别真的弹下载框 / 分享面板。要拿导出的文件，测试里再自己换一个接住它的
  useFileSaver(() => Promise.resolve());

  const root = document.createElement('div');

  // 和拖拽有关的测试要用「固定舞台」：把这一页钉在视口左上角，自己能滚。
  // 不这么做的话，卡片的位置取决于测试页当时滚到哪儿了 ——
  // 运行器连跑两遍，两遍的滚动位置不同，卡片有时正好贴着屏幕边缘，
  // 结果就会一遍过一遍不过。钉住之后坐标恒定，和页面滚动无关
  if (data.stage) {
    root.style.cssText =
      'position:fixed;left:0;top:0;width:390px;height:760px;overflow:auto;background:#fff;z-index:50;';
  }

  document.body.appendChild(root);

  onCleanup(() => {
    // 万一某条测试在「拖到一半」的时候失败了，拖拽挂在 document 上的那几个监听
    // 还留着，会在后面的测试里乱开枪。补一个 pointerup 让它正常收尾，
    // 再把可能残留的副本删掉
    try {
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    } catch (error) {
      /* 收尾失败不该影响测试结果 */
    }
    document.querySelectorAll('.drag-ghost').forEach((ghost) => ghost.remove());
    root.remove();
  });

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

// 模拟一次手指拖拽：按住 from 的中心 → 挪到 to 的中心 → 松手。
// 拖拽的代码把 pointermove / pointerup 挂在 document 上，所以后两步要发给 document。
// 起点必须是 from 的中心：浮起来那张是按「手指移动了多远」跟着走的，
// 起点写歪了，它就落不到目标上（判定看的是它盖住了谁）
function dragOnto(from, to) {
  // 先把要拖的那张滚到视野中间，再量坐标。
  // 真人也是看着东西拖的；而且贴着屏幕边缘拖会触发「自动滚动」，
  // 页面一滚，量好的坐标就对不上了 —— 这条测试为此飘过一次
  from.scrollIntoView({ block: 'center' });

  const source = from.getBoundingClientRect();
  const target = to.getBoundingClientRect();
  const x = target.left + target.width / 2;
  const y = target.top + target.height / 2;

  from.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true,
    clientX: source.left + source.width / 2,
    clientY: source.top + source.height / 2,
    pointerType: 'touch'
  }));

  // 等「浮起来那张」真的出现，再往下走。
  // 原来这里只等一轮事件循环（sleep(0)），赌的是长按定时器先跑完 ——
  // 赌输的时候手指一动就被当成「用户想滚页面」，拖拽根本没开始，
  // 结果就是两遍跑出来不一样。等到它出现最稳
  return waitUntil(() => document.querySelector('.drag-ghost')).then(() => {
    document.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: x, clientY: y, pointerType: 'touch'
    }));

    // 把「移动之后、松手之前」的现场留下来。
    // 出问题时光看结果没法查：到底是副本没跟上、还是落点没认出来
    const ghost = document.querySelector('.drag-ghost');
    const spot = ghost ? dropTargetAt(ghost, from.dataset.dropId) : null;
    const diagnosis = {
      副本位置: ghost ? ghost.getBoundingClientRect() : null,
      副本的style: ghost ? ghost.getAttribute('style') : null,
      副本的class: ghost ? ghost.getAttribute('class') : null,
      高亮的: [...document.querySelectorAll('.drop-target')].map((el) => el.dataset.dropId),
      当场算出的落点: spot ? spot.dataset.dropId : null,
      移到: { x: Math.round(x), y: Math.round(y) }
    };

    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
    return diagnosis;
  });
}

// 一直等到 check() 为真。注意别叫 waitFor —— media.js 里已经有一个同名的全局函数，
// 重名会把它盖掉（和「局部变量 items 盖住全局 items」是同一类坑）
function waitUntil(check, timeout = 500) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function poll() {
      if (check()) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error('等了 ' + timeout + 'ms，浮起来那张一直没出现'));
      }
      setTimeout(poll, 5);
    })();
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

test('视频截不出封面时，用占位封面照样能导入', async () => {
  // 3 秒的小视频也可能因为系统的解码限制截不出那一帧，
  // 这时候整条导入都失败是最糟的 —— 视频本身明明存得下
  const { root, storage, media, ready } = setup({
    processor: () => Promise.reject(new Error('解不开这个文件（错误码 4）'))
  });
  await ready;

  await importFile(fakeVideoFile());

  assertEqual(textOf(root, '.sheet-title'), '写点备注', '该照常进写备注那一页');
  assert(root.querySelector('.error-banner').textContent.includes('占位图'), '要说明封面是占位的');

  await saveDraft();

  const saved = JSON.parse(storage.getItem('items'));
  assertEqual(saved.length, 1, '视频该存下来');
  assertEqual(saved[0].type, 'video');
  assertEqual(media.files.size, 2, '原视频和占位封面都要存进去');
});

test('图片解不开时仍然报错，不会拿占位图凑数', async () => {
  const { root, storage, ready } = setup({
    processor: () => Promise.reject(new Error('这个格式不支持'))
  });
  await ready;

  await importFile(fakeImageFile());

  assertEqual(root.querySelector('.card.preview'), null, '不该进写备注那一页');
  assertEqual(storage.getItem('items'), null, '连解码都失败的图，存下来也是打不开的');
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

// ---- 备份 ----

// 把导出的文件接住，而不是真的下载下来
function captureExport() {
  const caught = {};
  useFileSaver((blob, filename) => {
    caught.blob = blob;
    caught.filename = filename;
    return Promise.resolve();
  });
  return caught;
}

test('zip 打包再读回来，字节一模一样（文件名是中文也行）', async () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 66, 66, 0]);
  const zip = makeZip([{ name: 'media/照片.jpg', bytes: bytes }]);

  const files = await readZip(zip);
  assertEqual([...files.keys()], ['media/照片.jpg']);
  assertEqual([...files.get('media/照片.jpg')], [...bytes], '读回来的内容必须和原来完全一样');
});

test('备份里装着 wishlist.json、原文件和缩略图', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1', note: '想买这个' })];
  const { ready } = setup({ items: seeded, media });
  await ready;

  const caught = captureExport();
  await exportBackup();

  assert(caught.blob, '应该导出了一个文件');
  assert(caught.filename.endsWith('.zip'), '导出的应该是 zip：' + caught.filename);

  const files = await readZip(caught.blob);
  assertEqual(files.size, 3, 'wishlist.json + 原文件 + 缩略图');

  const meta = JSON.parse(new TextDecoder().decode(files.get('wishlist.json')));
  assertEqual(meta.app, 'wishlist');
  assertEqual(meta.items.length, 1);
  assertEqual(meta.items[0].note, '想买这个');
});

test('导出的备份能在一个全新的空 App 里完整恢复', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1', note: '跑鞋' }), seedItem(media, { id: 'w-2' })];
  const first = setup({ items: seeded, media });
  await first.ready;

  dropOnto('w-1', 'w-2');                 // 顺便验文件夹也能跟着恢复
  const folderId = openFolderId;
  const caught = captureExport();
  await exportBackup();

  // 换一个全新的空 App：新存储、新文件仓库，就像换了台手机
  const freshMedia = createMemoryMediaStore();
  const second = setup({ media: freshMedia });
  await second.ready;
  assertEqual(items.length, 0, '新 App 一开始该是空的');

  await importBackup(new File([caught.blob], '备份.zip', { type: 'application/zip' }));

  assertEqual(items.length, 2, '两条记录都该回来');
  assertEqual(findItem('w-1').note, '跑鞋');
  assertEqual(folders.length, 1, '那一叠也该回来');
  assert(findFolder(folderId), '文件夹的 id 要对得上，照片才知道自己属于哪一叠');
  assertEqual(itemsIn(folderId).length, 2);
  assertEqual(freshMedia.files.size, 4, '两条记录 = 两个原文件 + 两个缩略图');
});

test('再恢复一次不会重复，已经有的会跳过', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, storage, ready } = setup({ items: seeded, media });
  await ready;

  openBackup();          // 结果提示画在备份页上，所以要先进这一页（真实操作也是这样）
  const caught = captureExport();
  await exportBackup();
  await importBackup(new File([caught.blob], '备份.zip', { type: 'application/zip' }));

  assertEqual(items.length, 2, '不该变成 4 条');
  assertEqual(JSON.parse(storage.getItem('items')).length, 2);
  assert(textOf(root, '.backup-status').includes('都已经在了'), '要告诉用户没有重复导入');
});

test('选错文件时给出提示，现有的东西一点不动', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' })];
  const { root, ready } = setup({ items: seeded, media });
  await ready;

  openBackup();
  await importBackup(new File(['这根本不是 zip'], '乱七八糟.zip', { type: 'application/zip' }));

  assert(textOf(root, '.backup-status').includes('恢复失败'), '要说清楚失败了');
  assertEqual(items.length, 1, '原来的记录一条都不能少');
});

test('墙上有备份入口，空着的时候也在（换手机后要靠它恢复）', async () => {
  const { root, ready } = setup();
  await ready;

  const entry = root.querySelector('.backup-entry');
  assert(entry, '墙上该有备份入口');

  click(entry);
  assertEqual(view, 'backup');
  assert(root.querySelector('.action-btn'), '备份页该有按钮');
});

// ---- 项目本身的检查 ----

// ---- 文件夹 ----

test('把一张拖到另一张上，两张合成一叠，并直接进到叠里', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, storage, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');

  assert(folderId, '应该建出一个文件夹');
  assertEqual(JSON.parse(storage.getItem('items')).map((i) => i.folderId), [folderId, folderId]);
  assertEqual(JSON.parse(storage.getItem('folders')).length, 1);
  assert(root.querySelector('.folder-name-input'), '应该进到这一叠里，等着起名字');
  assertEqual(cards(root).length, 2, '叠里应该有两张');
});

test('墙上显示的是一叠，不是散着的照片', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' }), seedItem(media, { id: 'w-3' })];
  const { root, ready } = setup({ items, media });
  await ready;

  dropOnto('w-1', 'w-2');
  closeFolder();

  const stacks = [...root.querySelectorAll('.folder-stack')];
  assertEqual(stacks.length, 1, '墙上该有一叠');
  assertEqual(cards(root).length, 2, '一叠的封面 + 还散着的那张');
  assert(textOf(root, '.folder-count').includes('2'), '叠上要写着里面有几张');
});

test('给一叠起的名字会存下来，写在白边上', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, storage, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  typeInto(root.querySelector('.folder-name-input'), '露营装备');
  closeFolder();

  assertEqual(JSON.parse(storage.getItem('folders'))[0].name, '露营装备');
  assertEqual(textOf(root, '.folder-name'), '露营装备');
  assertEqual(findFolder(folderId).name, '露营装备');
});

test('把一张拖到已有的一叠上，直接放进去', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' }), seedItem(media, { id: 'w-3' })];
  const { root, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  closeFolder();
  dropOnto('w-3', folderId);

  assertEqual(itemsIn(folderId).length, 3);
  assertEqual(root.querySelectorAll('.folder-stack').length, 1);
  assertEqual(looseItems().length, 0, '墙上不该还剩散着的照片');
});

test('点一叠能进去，里面只有这一叠的照片', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' }), seedItem(media, { id: 'w-3' })];
  const { root, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  closeFolder();
  click(root.querySelector('.folder-stack'));

  assertEqual(openFolderId, folderId);
  assertEqual(cards(root).length, 2, '只该显示叠里那两张');
});

test('叠里不能再拖，不做文件夹套文件夹', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  const again = dropOnto('w-1', 'w-2');

  assertEqual(again, null, '叠里的两张再拖不该建出新文件夹');
  assertEqual(folders.length, 1);
  assertEqual(itemsIn(folderId).length, 2);
});

test('在叠里点 ＋ 加的照片直接进这一叠', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { storage, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  await importFile(fakeImageFile());
  await saveDraft();

  assertEqual(itemsIn(folderId).length, 3);
  assertEqual(JSON.parse(storage.getItem('items'))[0].folderId, folderId);
  assertEqual(view, 'folder', '存完应该还待在这一叠里');
});

test('从叠里移出来，照片回到墙上', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' }), seedItem(media, { id: 'w-3' })];
  const { root, storage, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  dropOnto('w-3', folderId);
  await openDetail('w-1');
  click(root.querySelector('.text-link'));

  assertEqual(findItem('w-1').folderId, null);
  assertEqual(itemsIn(folderId).length, 2);
  assertEqual(JSON.parse(storage.getItem('items')).find((i) => i.id === 'w-1').folderId, null);
});

test('最后一张被移走，空掉的那叠自动消失', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, storage, ready } = setup({ items, media });
  await ready;

  const folderId = dropOnto('w-1', 'w-2');
  moveToFolder('w-1', null);
  moveToFolder('w-2', null);

  assertEqual(folders.length, 0, '空文件夹该自己消失');
  assertEqual(JSON.parse(storage.getItem('folders')).length, 0);
  assertEqual(findFolder(folderId), null);
  assertEqual(root.querySelectorAll('.folder-stack').length, 0);
  assertEqual(cards(root).length, 2, '两张都该回到墙上');
});

test('删掉叠里最后一张，那叠也跟着消失', async () => {
  const media = createMemoryMediaStore();
  // 这里的变量千万别叫 items —— 会盖住 app.js 里那个同名的全局记录表，
  // 断言就变成在查这份种子数据，永远查不出真实结果（这条测试栽过一次）
  const seeded = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { storage, ready } = setup({ items: seeded, media });
  await ready;

  dropOnto('w-1', 'w-2');
  await deleteItem('w-1');
  await deleteItem('w-2');

  assertEqual(folders.length, 0, '空掉的那叠该自己消失');
  assertEqual(JSON.parse(storage.getItem('items')).length, 0, '两条记录都该删掉');
  assertEqual(view, 'grid', '该回到墙上那一页');
});

test('记录指向一个已经不存在的文件夹时，回到墙上而不是凭空消失', async () => {
  const media = createMemoryMediaStore();
  const orphan = seedItem(media, { id: 'w-1' });
  orphan.folderId = 'f-没了';
  const { root, ready } = setup({ items: [orphan], media });
  await ready;

  assertEqual(findItem('w-1').folderId, null, '文件夹没了，这条记录该回到墙上');
  assertEqual(cards(root).length, 1, '照片必须还看得见');
});

test('刚放过东西的那叠排在最前面', async () => {
  const media = createMemoryMediaStore();
  const items = [
    seedItem(media, { id: 'w-new', createdAt: '2026-09-11T12:00:00.000Z' }),
    seedItem(media, { id: 'w-1', createdAt: '2026-09-10T10:00:00.000Z' }),
    seedItem(media, { id: 'w-2', createdAt: '2026-09-10T09:00:00.000Z' })
  ];
  const { ready } = setup({ items, media });
  await ready;

  // 建叠用的是「现在」（FIXED_NOW = 9-11 10:00），比 w-new 的 12:00 早
  dropOnto('w-1', 'w-2');
  closeFolder();

  const entries = wallEntries();
  assertEqual(entries[0].kind, 'item', '12 点那张最新，该排最前');
  assertEqual(entries[1].kind, 'folder');
});

test('拖拽用的落点标记在每张照片和每一叠上', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' }), seedItem(media, { id: 'w-3' })];
  const { root, ready } = setup({ items, media });
  await ready;

  dropOnto('w-1', 'w-2');
  closeFolder();

  const targets = [...root.querySelectorAll('[data-drop-id]')];
  assertEqual(targets.length, 2, '一叠 + 一张散着的');
  assert(targets.some((el) => el.classList.contains('folder-stack')), '叠也要能接住拖过来的照片');
});

test('长按拖动：手指按住、挪到另一张上松手，两张就合成一叠', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  // stage: 把这一页钉在固定位置再拖，卡片坐标才不受测试页滚动的影响
  const { root, ready } = setup({ items, media, stage: true });
  await ready;

  useLongPressDelay(0);          // 不用真等半秒
  const [first, second] = cards(root);
  const where = JSON.stringify({
    第一张: first.getBoundingClientRect(),
    第二张: second.getBoundingClientRect(),
    滚动: window.scrollY,
    视口高: window.innerHeight
  });

  const diagnosis = await dragOnto(first, second);

  assertEqual(findItem('w-1').folderId, findItem('w-2').folderId);
  // 失败时把当时的现场一起打出来 —— 这条测试和布局有关，
  // 光说「没合并」没法查
  assert(
    findItem('w-1').folderId,
    '应该已经归到同一叠里' +
    ' · 拖之前：' + where +
    ' · 拖的过程中：' + JSON.stringify(diagnosis)
  );
  assertEqual(document.querySelectorAll('.drag-ghost').length, 0, '跟着手指那个副本要收掉');
});

// 造一个假的「浮起来那张」，用来单独验落点判定
function fakeGhost(box, sourceId, offsetX = 0) {
  const ghost = document.createElement('div');
  ghost.dataset.dropId = sourceId;
  ghost.style.cssText = 'position:fixed;left:' + (box.left + offsetX) + 'px;top:' + box.top +
    'px;width:' + box.width + 'px;height:' + box.height + 'px;';
  document.body.appendChild(ghost);
  onCleanup(() => ghost.remove());
  return ghost;
}

test('浮起来那张要立刻跟手，不能带过渡动画', async () => {
  // 带动画的话，判定落点时它还在半路上，和目标没重叠，
  // 表现就是真机上「明明盖住了却放不进去」。这个坑踩过一次
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, ready } = setup({ items: seeded, media });
  await ready;

  useLongPressDelay(0);
  const card = cards(root)[0];
  const box = card.getBoundingClientRect();
  card.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, clientX: box.left + 5, clientY: box.top + 5, pointerType: 'touch'
  }));
  await waitUntil(() => document.querySelector('.drag-ghost'));

  const duration = getComputedStyle(document.querySelector('.drag-ghost')).transitionDuration;
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));

  assert(
    duration === '0s' || duration === '' || duration === 'none',
    '副本必须立刻跟手，实测过渡时长是 ' + duration
  );
});

test('落点看的是「盖住了谁」，不要求手指正好点在那张上', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, ready } = setup({ items: seeded, media });
  await ready;

  const second = cards(root)[1];
  // 盖住第二张，但整体偏了一点 —— 手指所在的位置未必落在第二张上
  const ghost = fakeGhost(second.getBoundingClientRect(), 'w-1', 8);

  const target = dropTargetAt(ghost, 'w-1');
  assert(target, '明明盖住了就该认');
  assertEqual(target.dataset.dropId, 'w-2');
});

test('落点用的是开始拖那一刻存下的位置，目标后来变形也不受影响', async () => {
  // 高亮会让目标摆正放大。要是每帧都重新量位置，判定就会在
  //「命中 / 不命中」之间反复横跳 —— 手感上就是「明明盖住了却没反应」。
  //
  // 这条测试写过两版都是假的：先用 .drop-target 类（变形带 160ms 过渡，
  // 断言时还没动），再用内联 transform（真实卡片的位置受布局牵连）。
  // 现在直接手写一份位置表喂给判定函数：存量版本必然命中，
  // 换成现量就必然落空，归因跑不掉
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, ready } = setup({ items: seeded, media, stage: true });
  await ready;

  const target = cards(root)[1];
  const box = target.getBoundingClientRect();
  const ghost = fakeGhost(box, 'w-1', 8);

  // 开始拖那一刻记下的位置（就是目标此刻所在的地方）
  const zones = [{
    element: target,
    left: box.left + window.scrollX,
    top: box.top + window.scrollY,
    right: box.right + window.scrollX,
    bottom: box.bottom + window.scrollY,
    area: box.width * box.height
  }];

  const spot = dropTargetIn(ghost, zones);
  assert(spot, '判定该按存下来的位置算，目标后来跑哪去了都不影响');
  assertEqual(spot.dataset.dropId, 'w-2');
  // 注意：判断「有没有找到落点」只能用 assert(x === null)。
  // assertEqual 是按 JSON 比较的，DOM 元素会被序列化成 {}，
  // 拿它跟 null 比永远不相等，拿两个不同元素比又永远相等 —— 等于没验

  // 反过来确认这条测试确实咬得住：换成「目标已经挪走」的那份位置，就该找不到落点。
  // 这里直接手写位置，不去真的搬动页面上的卡片 ——
  // 卡片的变形带着 160ms 过渡，刚设完样式它其实还没动，量出来跟没挪一样
  // （这个坑在这条测试上栽过两次了）
  const movedZones = [{
    element: target,
    left: zones[0].left + 3000,
    top: zones[0].top + 3000,
    right: zones[0].right + 3000,
    bottom: zones[0].bottom + 3000,
    area: zones[0].area
  }];
  assert(dropTargetIn(ghost, movedZones) === null, '目标挪走了就该落空 —— 这正是要避免的');
});

test('只擦过一点点不算落点，免得手一抖归错堆', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, ready } = setup({ items: seeded, media });
  await ready;

  const second = cards(root)[1];
  const box = second.getBoundingClientRect();
  // 只压住右边一小条
  const ghost = fakeGhost(box, 'w-1', box.width * 0.9);

  assert(dropTargetAt(ghost, 'w-1') === null, '只擦了一下不该算');
});

test('详情页直接放图，不套相框（长图套框两边会露黑边）', async () => {
  const media = createMemoryMediaStore();
  const seeded = [seedItem(media, { id: 'w-1' })];
  const { root, ready } = setup({ items: seeded, media });
  await ready;

  await openDetail('w-1');
  const stage = root.querySelector('.detail-media');
  assert(stage.querySelector('img'), '详情页要有大图');
  assertEqual(stage.querySelectorAll('.card').length, 0, '详情页不该再有拍立得相框');
});

test('只是点一下（没挪动）不会触发拖拽，正常进详情页', async () => {
  const media = createMemoryMediaStore();
  const items = [seedItem(media, { id: 'w-1' }), seedItem(media, { id: 'w-2' })];
  const { root, ready } = setup({ items, media });
  await ready;

  useLongPressDelay(0);
  const card = cards(root)[0];
  card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 10, clientY: 10, pointerType: 'touch' }));
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  click(card);

  assertEqual(folders.length, 0, '没挪动就不该建文件夹');
  assertEqual(view, 'detail', '应该正常进了详情页');
});

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
