// 点击插件图标：已有对比页就切过去，没有就新开一个
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('compare.html');
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// 后台标签页里的定时器会被 Chrome 严重限速（隐藏 5 分钟后最慢一分钟才触发一次），
// 内容脚本改为请求这里代为计时，消息回复不受限速影响
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'yx-sleep') return;
  setTimeout(() => sendResponse(true), Math.max(0, Math.min(+msg.ms || 0, 30_000)));
  return true;
});
