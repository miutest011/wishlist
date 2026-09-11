// 一个极简的测试运行器。没有任何依赖，浏览器打开 tools/test.html 就能跑。
//
// 用法：
//   test('这个功能应该……', () => {
//     assertEqual(实际值, 期望值, '哪里不对');
//   });
// 测试函数里抛出错误 = 这条测试失败，否则算通过。

const tests = [];
const cleanups = [];

function test(name, fn) {
  tests.push({ name: name, fn: fn });
}

// 每条测试跑完后要做的清理（比如把临时创建的元素删掉）
function onCleanup(fn) {
  cleanups.push(fn);
}

// 数一数每条测试到底做了几次断言。
// 一次都没有的测试是"假测试"：看着有，其实什么都没验证
let assertionCount = 0;

function assert(condition, message) {
  assertionCount++;
  if (!condition) {
    throw new Error(message || '断言失败：期望条件为真');
  }
}

// 用 JSON 比较，所以数组和对象也能直接比
function assertEqual(actual, expected, message) {
  assertionCount++;
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    throw new Error(
      (message || '两个值不相等') +
      '\n    实际值：' + actualText +
      '\n    期望值：' + expectedText
    );
  }
}

// 假的存储，用来代替 localStorage。
// 数据只存在内存里，测试跑完就没了，绝对不会碰到你的真实数据。
function createMemoryStorage() {
  let data = {};
  return {
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; },
    clear: () => { data = {}; }
  };
}

// 假的文件仓库，用来代替 IndexedDB。同样只存在内存里。
// files 暴露出来，方便测试检查「文件到底存进去没有、删干净没有」
function createMemoryMediaStore() {
  const files = new Map();
  return {
    files: files,
    save: (id, blob) => { files.set(id, blob); return Promise.resolve(); },
    load: (id) => Promise.resolve(files.has(id) ? files.get(id) : null),
    remove: (id) => { files.delete(id); return Promise.resolve(); }
  };
}

// 有些检查只能在特定环境下跑 —— 比如要读项目里的文件，
// 双击打开测试页（file://）时浏览器不让读。
// 这时调用 skip('原因')：这条测试显示成"跳过"，既不算失败，
// 也不会被当成"没有断言"的假测试
function skip(reason) {
  const signal = new Error(reason);
  signal.skipped = true;
  throw signal;
}

// 把所有测试跑一遍，返回每条的结果。不碰页面
//
// 测试函数可以是普通函数，也可以是 async 函数（附件相关的测试要等异步操作完成）。
// await 一个普通返回值也是合法的，所以两种写法都能跑
async function runOnce() {
  const results = [];

  for (const { name, fn } of tests) {
    assertionCount = 0;
    let error = null;

    try {
      await fn();
    } catch (e) {
      error = e;
    }

    // 不管这条测试成功还是失败，都要把它留下的东西清理干净，
    // 否则会影响到后面的测试
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      try {
        cleanup();
      } catch (e) {
        console.error('清理时出错：', e);
      }
    }

    const skipped = Boolean(error && error.skipped);
    results.push({
      name: name,
      error: skipped ? null : error,
      skipped: skipped,
      skipReason: skipped ? error.message : '',
      assertions: assertionCount
    });
  }

  return results;
}

// 一条测试的结局：通过 / 失败 / 跳过
function outcomeOf(result) {
  if (result.skipped) return 'skip';
  return result.error ? 'fail' : 'pass';
}

async function runTests(outputEl, summaryEl) {
  outputEl.innerHTML = '';
  summaryEl.className = 'summary';
  summaryEl.textContent = '正在运行……';

  // 连跑两遍。
  // 为什么：如果某条测试改了全局状态却没还原，第一遍常常看不出来，
  // 要等下一遍才会露馅 —— 这种"结果取决于执行顺序"的问题最难查。
  // 让它每次都自动暴露，比指望哪天碰巧发现要靠谱
  const first = await runOnce();
  const second = await runOnce();

  const unstable = first.filter(
    (result, index) => outcomeOf(result) !== outcomeOf(second[index])
  );

  const failed = first.filter((result) => outcomeOf(result) === 'fail').length;
  const skippedCount = first.filter((result) => result.skipped).length;
  const passed = first.length - failed - skippedCount;
  // 通过了但一次断言都没做 —— 这种测试等于没写
  const empty = first.filter((result) => outcomeOf(result) === 'pass' && result.assertions === 0);

  // 两遍结果不一致时，最要紧的是先说这件事
  if (unstable.length > 0) {
    const warning = document.createElement('div');
    warning.className = 'banner';
    warning.textContent =
      '⚠️ 连跑两遍结果不一样，说明测试之间有状态泄漏（某条测试改了全局状态没还原）：'
      + unstable.map((result) => result.name).join('、');
    outputEl.appendChild(warning);
  }

  if (empty.length > 0) {
    const warning = document.createElement('div');
    warning.className = 'banner';
    warning.textContent =
      '⚠️ 下面这些测试一次断言都没做，等于没测：'
      + empty.map((result) => result.name).join('、');
    outputEl.appendChild(warning);
  }

  first.forEach((result) => {
    const row = document.createElement('div');

    if (result.error) {
      row.className = 'result fail';
      row.textContent = '✗ ' + result.name;
      const detail = document.createElement('pre');
      detail.className = 'error';
      detail.textContent = result.error.message;
      row.appendChild(detail);
    } else if (result.skipped) {
      row.className = 'result skip';
      row.textContent = '○ ' + result.name + '（跳过：' + result.skipReason + '）';
    } else if (result.assertions === 0) {
      row.className = 'result warn';
      row.textContent = '⚠ ' + result.name + '（没有任何断言）';
    } else {
      row.className = 'result pass';
      row.textContent = '✓ ' + result.name;
    }

    outputEl.appendChild(row);
  });

  const problems = [];
  if (failed > 0) problems.push(`${failed} 条失败`);
  if (unstable.length > 0) problems.push(`${unstable.length} 条结果不稳定`);
  if (empty.length > 0) problems.push(`${empty.length} 条没有断言`);

  // "跳过"不算问题，但要写出来 —— 免得你以为那几条也验证过了
  const skippedNote = skippedCount > 0 ? `，跳过 ${skippedCount} 条` : '';

  summaryEl.className = problems.length > 0 ? 'summary fail' : 'summary pass';
  summaryEl.textContent = problems.length > 0
    ? `${problems.join('，')}${skippedNote}（共 ${tests.length} 条）`
    : `全部通过：${passed} 条${skippedNote}（共 ${tests.length} 条，已连跑两遍）`;
}
