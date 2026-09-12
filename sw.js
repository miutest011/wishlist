// Service Worker：把网页文件缓存到手机里，装成 App 之后离线也能打开。
//
// 重要：改完代码要把下面的版本号 +1，否则手机上还会用旧的缓存。
const VERSION = 'v3';
const CACHE_NAME = `wishlist-${VERSION}`;

// 需要缓存的文件。只有这几个 —— 你导进来的照片和视频存在浏览器自己的数据库里，
// 不归这里管。index.html 里每多加载一个脚本，这里就要多加一行（有测试盯着，漏了会报红）
const FILES = [
  './',
  './index.html',
  './style.css',
  './media.js',
  './backup.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

// 安装：把上面这些文件下载下来存起来
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(FILES))
      .then(() => self.skipWaiting())   // 新版本装好就直接生效，不用等所有标签页关掉
  );
});

// 激活：把旧版本的缓存清掉，免得越积越多
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names
          .filter((name) => name.startsWith('wishlist-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 带查询参数的请求一律放行，用来在开发时绕开缓存。
  // 比如测试页加载的是 app.js?t=…，这样永远拿到最新的代码
  if (url.search) return;

  // 只接管上面列出的那几个文件，测试页（tools/ 里的东西）一律走网络
  const isCached = FILES.some((file) => {
    const path = new URL(file, self.registration.scope).pathname;
    return path === url.pathname;
  });

  if (!isCached || event.request.method !== 'GET') {
    return;   // 不处理，交给浏览器正常走网络
  }

  // 本地开发时（localhost）用「网络优先」：永远拿最新的代码，拿不到才退回缓存。
  // 不这么做的话，改完代码刷新页面看到的还是旧版本，会白白查很久。
  // 线上（手机上装的那份）仍然是缓存优先，打开快、离线也能用
  const isLocalDev = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

  const fromNetwork = fetch(event.request)
    .then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
      }
      return response;
    });

  if (isLocalDev) {
    event.respondWith(fromNetwork.catch(() => caches.match(event.request)));
    return;
  }

  // 先给缓存里的，同时在后台悄悄更新一份供下次使用
  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fromNetwork.catch(() => cached)
    )
  );
});
