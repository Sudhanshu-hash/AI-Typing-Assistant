document.addEventListener("DOMContentLoaded", () => {
  const enabled = document.getElementById("enabled");
  const targetLang = document.getElementById("targetLang");
  const autoReplace = document.getElementById("autoReplace");

  chrome.storage.sync.get(
    { enabled: true, targetLang: "no", autoReplace: false },
    (s) => {
      enabled.checked = s.enabled;
      targetLang.value = s.targetLang;
      autoReplace.checked = s.autoReplace;
    }
  );

  function save() {
    const settings = {
      enabled: enabled.checked,
      targetLang: targetLang.value,
      autoReplace: autoReplace.checked
    };

    chrome.storage.sync.set(settings, () => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "AI_SETTINGS_UPDATED",
          payload: settings
        });
      });
    });
  }

  enabled.addEventListener("change", save);
  targetLang.addEventListener("change", save);
  autoReplace.addEventListener("change", save);
});
