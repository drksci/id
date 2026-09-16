(() => {
  let deferredPrompt;
  window.addEventListener("load", () => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {}); });
  document.addEventListener("DOMContentLoaded", () => {
    const main = document.querySelector("main");
    if (!main || document.querySelector("[data-install-app]")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.installApp = "";
    button.hidden = true;
    button.textContent = "Install drksci / id";
    const fallback = document.createElement("span");
    fallback.dataset.installFallback = "";
    fallback.hidden = true;
    fallback.textContent = "Use your browser menu to install drksci / id.";
    main.prepend(fallback);
    main.prepend(button);
  });
  const installButtons = () => [...document.querySelectorAll("[data-install-app]")];
  const fallback = () => document.querySelector("[data-install-fallback]");
  const showFallback = () => { const node = fallback(); if (node) node.hidden = false; };
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event;
    installButtons().forEach((button) => { button.hidden = false; button.disabled = false; });
  });
  document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-install-app]");
    if (!button || !deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installButtons().forEach((item) => { item.hidden = true; });
    showFallback();
  });
  window.addEventListener("appinstalled", () => { installButtons().forEach((button) => { button.hidden = true; }); });
  window.setTimeout(() => { if (!deferredPrompt) showFallback(); }, 1500);
})();
