// 媒体文件的存放和处理。
//
// 界面代码（app.js）不直接碰 IndexedDB，也不直接碰 canvas，只调用这里的几个函数。
// 这么分是为了以后好搬家：把这个网页装进 iOS App 的时候，
// 只要把这个文件换成「存到 App 自己的文件夹里」，界面代码一行都不用动。

// 缩略图的边长。宫格里的照片是正方形的，所以缩略图也做成正方形（居中裁剪）。
// 600 是按 2 倍屏的显示尺寸给的，再大只是白占空间
const THUMB_SIZE = 600;

// ---- 文件仓库 ----
// 记录本身（备注、时间这些文字）存在 localStorage 里，那里只能放文字、总共才 5MB 左右。
// 图片和视频放不下，所以单独存进 IndexedDB —— 浏览器自带的本地数据库，能直接存文件。
// 记录里只记住文件的 id，内容按 id 来这里取。
function createIndexedDbMediaStore(dbName) {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('files');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return dbPromise;
  }

  function run(mode, action) {
    return open().then((db) => new Promise((resolve, reject) => {
      const request = action(db.transaction('files', mode).objectStore('files'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }));
  }

  return {
    save: (id, blob) => run('readwrite', (store) => store.put(blob, id)),
    load: (id) => run('readonly', (store) => store.get(id)),
    remove: (id) => run('readwrite', (store) => store.delete(id))
  };
}

// ---- 读文件、生成缩略图 ----

// 用完立刻把临时地址还回去，不然这块内存要等到刷新页面才释放
function withObjectUrl(blob, use) {
  const url = URL.createObjectURL(blob);
  return Promise.resolve()
    .then(() => use(url))
    .finally(() => URL.revokeObjectURL(url));
}

// 等某个元素加载完。超时是必须的：遇到浏览器解不开的格式时，
// loadeddata 这类事件可能永远不来，没有超时就会一直卡在「正在处理」
function waitFor(element, eventName, seconds) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('等了太久也没读出来'));
    }, seconds * 1000);

    function cleanup() {
      clearTimeout(timer);
      element.removeEventListener(eventName, onDone);
      element.removeEventListener('error', onError);
    }
    function onDone() { cleanup(); resolve(); }
    function onError() { cleanup(); reject(new Error('这个文件读不出来')); }

    element.addEventListener(eventName, onDone);
    element.addEventListener('error', onError);
  });
}

// 把一张图（或者视频的一帧）居中裁成正方形，画进 canvas，再导出成 jpg
function toSquareThumbnail(source, width, height) {
  const side = Math.min(width, height);
  const size = Math.min(THUMB_SIZE, side);

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d').drawImage(
    source,
    (width - side) / 2, (height - side) / 2, side, side,  // 从原图中间取一个正方形
    0, 0, size, size
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('缩略图没生成出来'))),
      'image/jpeg',
      0.82
    );
  });
}

function processImage(file) {
  return withObjectUrl(file, (url) => {
    const image = new Image();
    image.src = url;
    return waitFor(image, 'load', 20)
      .then(() => toSquareThumbnail(image, image.naturalWidth, image.naturalHeight))
      .then((thumb) => ({
        type: 'image',
        thumb: thumb,
        width: image.naturalWidth,
        height: image.naturalHeight,
        duration: null
      }));
  });
}

function processVideo(file) {
  return withObjectUrl(file, (url) => {
    const video = document.createElement('video');
    // iPhone 上这两个属性不能少：不静音、不加 playsinline 的话，
    // Safari 会拒绝在后台解码，截不出封面
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = url;

    return waitFor(video, 'loadeddata', 30)
      .then(() => {
        // 第一帧常常是黑的（还没渐入），往后跳一点点再截
        video.currentTime = Math.min(0.2, (video.duration || 1) / 2);
        return waitFor(video, 'seeked', 20);
      })
      .then(() => toSquareThumbnail(video, video.videoWidth, video.videoHeight))
      .then((thumb) => ({
        type: 'video',
        thumb: thumb,
        width: video.videoWidth,
        height: video.videoHeight,
        duration: isFinite(video.duration) ? video.duration : null
      }));
  });
}

// 界面只用这一个函数：给它一个文件，拿回「类型、缩略图、尺寸、时长」
function processMedia(file) {
  const type = file.type || '';
  if (type.startsWith('video/')) return processVideo(file);
  if (type.startsWith('image/')) return processImage(file);
  return Promise.reject(new Error('只支持图片和视频'));
}

// 34.2 秒 → 0:34
function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const total = Math.round(seconds);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}
