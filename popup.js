function getMode() {
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'ratio';
  return mode;
}

function parseWeights(raw, count) {
  if (!raw || !raw.trim()) {
    return Array.from({ length: count }, () => 1);
  }
  // 仅允许正整数；支持逗号、空格、中文逗号分隔
  const tokens = raw
    .split(/[，,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const parts = [];
  for (const t of tokens) {
    if (!/^\d+$/.test(t)) throw new Error(`仅允许正整数，发现非法值："${t}"`);
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`仅允许正整数，发现非法值："${t}"`);
    parts.push(n);
  }
  if (parts.length === 0) return Array.from({ length: count }, () => 1);
  if (parts.length === 1) return Array.from({ length: count }, () => parts[0]);
  // 如果长度小于count，循环填充；大于count则截断
  const weights = new Array(count);
  for (let i = 0; i < count; i++) weights[i] = parts[i % parts.length];
  return weights;
}

async function queryInputsInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error('未找到活动标签页');
  // 尝试优先通过页面脚本统计
  const { count = 0 } = await chrome.tabs
    .sendMessage(tab.id, { type: 'COUNT_INPUTS' })
    .catch(() => ({ count: 0 }));
  if (count && count > 0) return { tab, count };
  // 回退：直接在页面执行统计（支持 shadow DOM 与 iframe）
  const results = await chrome.scripting
    .executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        function collectRateInputsFromRoot(doc) {
          const found = Array.from(doc.querySelectorAll('input.distrbutionInput.rateInput'));
          const traverse = (node, acc) => {
            if (!node) return;
            if (node.shadowRoot) {
              acc.push(...node.shadowRoot.querySelectorAll('input.distrbutionInput.rateInput'));
              for (const child of node.shadowRoot.querySelectorAll('*')) traverse(child, acc);
            }
            for (const child of node.children || []) traverse(child, acc);
          };
          for (const el of doc.querySelectorAll('*')) traverse(el, found);
          return found.length;
        }
        return collectRateInputsFromRoot(document);
      },
    })
    .catch(() => []);
  const fallbackCount = (results || []).reduce((s, r) => s + (r?.result || 0), 0);
  return { tab, count: fallbackCount || 0 };
}

function sendApply(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, { type: 'APPLY_DISTRIBUTION', payload });
}

document.getElementById('applyBtn').addEventListener('click', async () => {
  const mode = getMode();
  const { tab, count } = await queryInputsInTab();
  if (count <= 0) {
    alert('未找到任何比例输入框(.rateInput)。');
    return;
  }
  if (mode === 'ratio') {
    try {
      const raw = document.getElementById('ratioInput').value;
      const weights = parseWeights(raw, count);
      // 首选发送到页面脚本
      const ok = await chrome.tabs
        .sendMessage(tab.id, { type: 'APPLY_DISTRIBUTION', payload: { mode, weights } })
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        // 回退：先统计各 frame 输入框数量，再逐 frame 分段写入
        const countsPerFrame = await chrome.scripting
          .executeScript({
            target: { tabId: tab.id, allFrames: true },
            func: () => Array.from(document.querySelectorAll('input.distrbutionInput.rateInput')).length,
          })
          .catch(() => []);
        let cursor = 0;
        for (const frame of countsPerFrame) {
          const frameCount = frame?.result || 0;
          if (!frameCount) continue;
          const slice = weights.slice(cursor, cursor + frameCount);
          cursor += frameCount;
          await chrome.scripting.executeScript({
            target: { tabId: tab.id, frameIds: [frame.frameId] },
            args: [slice],
            func: (vals) => {
              const inputs = Array.from(document.querySelectorAll('input.distrbutionInput.rateInput'));
              const n = inputs.length;
              const src = vals && vals.length ? vals : Array.from({ length: n }, () => 1);
              for (let i = 0; i < n; i++) {
                const el = inputs[i];
                const v = src[i % src.length];
                el.value = String(v);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof el.onblur === 'function') {
                  try { el.onblur(new FocusEvent('blur')); } catch (_) {}
                }
              }
            },
          });
        }
      }
    } catch (e) {
      alert(e.message || '输入必须为正整数');
      return;
    }
  } else {
    // 平均分配：优先消息，失败则直接执行
    const keepReserve = !!document.getElementById('keepReserve')?.checked;
    const ok = await chrome.tabs
      .sendMessage(tab.id, { type: 'APPLY_DISTRIBUTION', payload: { mode, keepReserve } })
      .then(() => true)
      .catch(() => false);
    if (!ok) {
      const countsPerFrame = await chrome.scripting
        .executeScript({
          target: { tabId: tab.id, allFrames: true },
          func: () => Array.from(document.querySelectorAll('input.distrbutionInput.rateInput')).length,
        })
        .catch(() => []);
      // 全局平均：先构造总数组，再按frame切片写入；若勾选保留库存，则多一个名额（最后一个）不写入
      const total = (countsPerFrame || []).reduce((s, r) => s + (r?.result || 0), 0);
      const globalN = keepReserve ? total + 1 : total;
      const globalVals = (() => {
        function averagePositiveIntegers(n) {
          if (n <= 0) return [];
          const base = Math.floor(100 / n);
          const remain = 100 - base * n;
          const arr = Array.from({ length: n }, () => Math.max(1, base));
          for (let i = 0; i < remain; i++) arr[i % n] += 1;
          let sum = arr.reduce((a, b) => a + b, 0);
          if (sum !== 100) {
            let delta = sum - 100;
            let k = arr.length - 1;
            while (delta > 0 && k >= 0) {
              const can = Math.min(delta, arr[k] - 1);
              if (can > 0) { arr[k] -= can; delta -= can; }
              k -= 1;
            }
          }
          return arr;
        }
        return averagePositiveIntegers(globalN);
      })();
      let cursor = 0;
      for (const frame of countsPerFrame) {
        const frameCount = frame?.result || 0;
        if (!frameCount) continue;
        const slice = globalVals.slice(cursor, cursor + frameCount);
        cursor += frameCount;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frame.frameId] },
          args: [slice],
          func: (vals) => {
            const inputs = Array.from(document.querySelectorAll('input.distrbutionInput.rateInput'));
            for (let i = 0; i < inputs.length; i++) {
              const el = inputs[i];
              el.value = String(vals[i] ?? 0);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              if (typeof el.onblur === 'function') {
                try { el.onblur(new FocusEvent('blur')); } catch (_) {}
              }
            }
          },
        });
      }
    }
  }
  window.close();
});


