chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.action.onClicked.addListener(async (tab) => {
  const url = new URL(chrome.runtime.getURL("manager.html"));
  if (tab?.url?.startsWith("https://chatgpt.com/")) url.searchParams.set("source", tab.id);
  await chrome.tabs.create({ url: url.href });
});
