// background.js - manages context menu and global settings
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ai-correct-translate',
    title: 'Correct & Translate selection',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ai-correct-translate') {
    chrome.scripting.executeScript({
      target: {tabId: tab.id},
      func: (selectedText) => {
        // dispatch a custom event with the selected text
        window.dispatchEvent(new CustomEvent('AI_EXT_SELECTION', {detail: selectedText}));
      },
      args: [info.selectionText]
    });
  }
});