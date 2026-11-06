chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const PLATFORM_BY_ORIGIN = [
  ["https://chatgpt.com/", "chatgpt"],
  ["https://chat.deepseek.com/", "deepseek"]
];
chrome.action.onClicked.addListener(async (tab) => {
  const url = new URL(chrome.runtime.getURL("manager.html"));
  const hit = PLATFORM_BY_ORIGIN.find(([prefix]) => tab?.url?.startsWith(prefix));
  if (hit && Number.isInteger(tab.id)) {
    url.searchParams.set("source", tab.id);
    url.searchParams.set("platform", hit[1]);
  }
  await chrome.tabs.create({ url: url.href });
});
