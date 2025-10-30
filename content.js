(function () {
  function collectRateInputsFromRoot(doc) {
    const found = Array.from(doc.querySelectorAll('input.distrbutionInput.rateInput'));
    // 遍历包含的 shadow roots
    const traverse = (node, acc) => {
      if (!node) return;
      if (node.shadowRoot) {
        acc.push(...node.shadowRoot.querySelectorAll('input.distrbutionInput.rateInput'));
        for (const child of node.shadowRoot.querySelectorAll('*')) traverse(child, acc);
      }
      for (const child of node.children || []) traverse(child, acc);
    };
    for (const el of doc.querySelectorAll('*')) traverse(el, found);
    // 遍历 iframe
    const iframes = Array.from(doc.querySelectorAll('iframe'));
    for (const f of iframes) {
      try {
        const idoc = f.contentDocument || f.contentWindow?.document;
        if (idoc) found.push(...collectRateInputsFromRoot(idoc));
      } catch (_) {
        // 跨域iframe忽略
      }
    }
    return found;
  }

  function getRateInputs() {
    return collectRateInputsFromRoot(document);
  }

  function toPositiveIntegersSum100(values) {
    const n = values.length;
    if (n === 0) return [];
    // 归一化到100并确保为正整数
    const sum = values.reduce((a, b) => a + b, 0);
    const raw = values.map((v) => (v / sum) * 100);
    const floors = raw.map((x) => Math.max(1, Math.floor(x)));
    let current = floors.reduce((a, b) => a + b, 0);
    // 若总和不足/超过100，进行余量分配/扣减，保持每项>=1
    const order = raw
      .map((x, i) => ({ i, frac: x - Math.floor(x) }))
      .sort((a, b) => b.frac - a.frac)
      .map((o) => o.i);
    let idx = 0;
    if (current < 100) {
      while (current < 100) {
        const i = order[idx % n];
        floors[i] += 1;
        current += 1;
        idx += 1;
      }
    } else if (current > 100) {
      // 先从小数部分小的扣，尽量不破坏精度
      const orderAsc = raw
        .map((x, i) => ({ i, frac: x - Math.floor(x) }))
        .sort((a, b) => a.frac - b.frac)
        .map((o) => o.i);
      let j = 0;
      while (current > 100) {
        const i = orderAsc[j % n];
        if (floors[i] > 1) {
          floors[i] -= 1;
          current -= 1;
        }
        j += 1;
      }
    }
    // 保证全为正整数且和为100
    return floors;
  }

  function averagePositiveIntegers(n) {
    if (n <= 0) return [];
    const base = Math.floor(100 / n);
    const remain = 100 - base * n;
    const arr = Array.from({ length: n }, () => Math.max(1, base));
    for (let i = 0; i < remain; i++) arr[i % n] += 1;
    // 若base为0（n>100），上面也会保证至少为1并自动超过100，需要再回调到100
    const sum = arr.reduce((a, b) => a + b, 0);
    if (sum !== 100) {
      // 简单修正：从末尾开始扣到100，保持>=1
      let delta = sum - 100;
      let k = arr.length - 1;
      while (delta > 0 && k >= 0) {
        const can = Math.min(delta, arr[k] - 1);
        if (can > 0) {
          arr[k] -= can;
          delta -= can;
        }
        k -= 1;
      }
    }
    return arr;
  }

  function applyValues(vals) {
    const inputs = getRateInputs();
    const n = inputs.length;
    const values = vals.slice(0, n);
    for (let i = 0; i < n; i++) {
      const el = inputs[i];
      const v = values[i] ?? 0;
      el.value = String(v);
      // 触发页面可能监听的事件
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      // 若存在onblur校验函数，手动调用（不模拟人工，仅触发逻辑）
      if (typeof el.onblur === 'function') {
        try { el.onblur(new FocusEvent('blur')); } catch (_) {}
      }
    }
  }

  function waitForInputs(timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 5000);
    return new Promise((resolve) => {
      const tryOnce = () => {
        const arr = getRateInputs();
        if (arr.length > 0 || Date.now() >= deadline) {
          resolve(arr);
          return;
        }
        requestAnimationFrame(tryOnce);
      };
      tryOnce();
    });
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'COUNT_INPUTS') {
      try {
        const n = getRateInputs().length;
        sendResponse({ count: n });
      } catch (e) {
        sendResponse({ count: 0 });
      }
      return true;
    }
    if (!msg || msg.type !== 'APPLY_DISTRIBUTION') return;
    waitForInputs(5000).then(() => {
      const n = getRateInputs().length;
      if (n === 0) {
        sendResponse({ ok: false, error: 'NO_INPUTS' });
        return;
      }
    if (msg.payload?.mode === 'average') {
      const extra = msg.payload?.keepReserve ? 1 : 0;
      const arr = averagePositiveIntegers(n + extra).slice(0, n);
      applyValues(arr);
        sendResponse({ ok: true, mode: 'average', values: arr });
        return;
      }
      // 比例分配：直接使用用户输入的数值
      const source = Array.isArray(msg.payload?.weights) && msg.payload.weights.length > 0
        ? msg.payload.weights
        : Array.from({ length: n }, () => 1);
      const weights = new Array(n);
      for (let i = 0; i < n; i++) {
        const val = source[i % source.length];
        weights[i] = Number.isFinite(Number(val)) ? Number(val) : 0;
      }
      applyValues(weights);
      sendResponse({ ok: true, mode: 'ratio', values: weights });
    });
    return true;
  });
})();


