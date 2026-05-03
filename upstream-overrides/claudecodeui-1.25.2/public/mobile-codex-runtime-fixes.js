(function () {
  var CODEX_MODEL_STORAGE_KEY = "codex-model";
  var CODEX_REASONING_STORAGE_KEY = "codex-reasoning-effort";
  var CODEX_MODEL_MIGRATION_KEY = "codex-model-default-migrated-to-5.5";
  var DEFAULT_CODEX_MODEL = "gpt-5.5";
  var VALID_REASONING_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];

  function migrateDefaultCodexModel() {
    try {
      if (localStorage.getItem(CODEX_MODEL_MIGRATION_KEY)) {
        return;
      }

      var storedModel = localStorage.getItem(CODEX_MODEL_STORAGE_KEY);
      if (!storedModel || storedModel === "gpt-5.4") {
        localStorage.setItem(CODEX_MODEL_STORAGE_KEY, DEFAULT_CODEX_MODEL);
      }

      localStorage.setItem(CODEX_MODEL_MIGRATION_KEY, "1");
    } catch (error) {
      console.warn("[mobile-codex] failed to migrate codex model", error);
    }
  }

  function getStoredCodexModel() {
    try {
      return localStorage.getItem(CODEX_MODEL_STORAGE_KEY) || DEFAULT_CODEX_MODEL;
    } catch {
      return DEFAULT_CODEX_MODEL;
    }
  }

  function getStoredReasoningEffort() {
    try {
      var value = localStorage.getItem(CODEX_REASONING_STORAGE_KEY) || "";
      return VALID_REASONING_EFFORTS.indexOf(value) >= 0 ? value : "";
    } catch {
      return "";
    }
  }

  function isCodexModelSelect(select) {
    if (!(select instanceof HTMLSelectElement)) {
      return false;
    }

    var optionValues = Array.from(select.options).map(function (option) {
      return option.value;
    });

    return optionValues.indexOf("gpt-5.4") >= 0 && optionValues.indexOf("gpt-5.3-codex") >= 0;
  }

  function ensureCodexModelOption(select) {
    if (select.querySelector('option[value="gpt-5.5"]')) {
      return;
    }

    var option = document.createElement("option");
    option.value = "gpt-5.5";
    option.textContent = "GPT-5.5";
    select.insertBefore(option, select.firstChild);
  }

  function syncCodexModelSelection(select) {
    var storedModel = getStoredCodexModel();
    if (select.value !== storedModel) {
      select.value = storedModel;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function createReasoningWrapper(select) {
    var row = select.closest(".flex.items-center.justify-center.gap-2");
    if (!row || !row.parentElement) {
      return;
    }

    if (row.parentElement.querySelector('[data-mobile-codex-reasoning="true"]')) {
      return;
    }

    var wrapper = document.createElement("div");
    wrapper.setAttribute("data-mobile-codex-reasoning", "true");
    wrapper.className = row.className + " mt-3";

    var label = document.createElement("span");
    label.className = "text-sm text-muted-foreground";
    label.textContent = "推理程度";

    var relative = document.createElement("div");
    relative.className = "relative";

    var reasoningSelect = document.createElement("select");
    reasoningSelect.className =
      "cursor-pointer appearance-none rounded-lg border border-border/60 bg-muted/50 py-1.5 pl-3 pr-7 text-sm font-medium text-foreground transition-colors hover:bg-muted focus:outline-none focus:ring-2 focus:ring-primary/20";

    [
      ["", "默认"],
      ["minimal", "最低"],
      ["low", "低"],
      ["medium", "中"],
      ["high", "高"],
      ["xhigh", "很高"],
    ].forEach(function (entry) {
      var option = document.createElement("option");
      option.value = entry[0];
      option.textContent = entry[1];
      reasoningSelect.appendChild(option);
    });

    reasoningSelect.value = getStoredReasoningEffort();
    reasoningSelect.addEventListener("change", function () {
      try {
        localStorage.setItem(CODEX_REASONING_STORAGE_KEY, reasoningSelect.value || "");
      } catch (error) {
        console.warn("[mobile-codex] failed to save reasoning effort", error);
      }
    });

    var icon = document.createElement("span");
    icon.className =
      "pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground";
    icon.textContent = "▾";

    relative.appendChild(reasoningSelect);
    relative.appendChild(icon);
    wrapper.appendChild(label);
    wrapper.appendChild(relative);
    row.insertAdjacentElement("afterend", wrapper);
  }

  function patchCodexSelectors() {
    var selects = document.querySelectorAll("select");
    selects.forEach(function (select) {
      if (!isCodexModelSelect(select)) {
        return;
      }

      ensureCodexModelOption(select);
      syncCodexModelSelection(select);
      createReasoningWrapper(select);
    });
  }

  function patchWebSocketSend() {
    if (typeof WebSocket === "undefined" || WebSocket.prototype.__mobileCodexPatched) {
      return;
    }

    var originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      if (typeof data === "string") {
        try {
          var payload = JSON.parse(data);
          if (payload && payload.type === "codex-command") {
            payload.options = payload.options || {};

            var storedModel = getStoredCodexModel();
            if (!payload.options.model || payload.options.model === "gpt-5.4") {
              payload.options.model = storedModel;
            }

            var reasoningEffort = getStoredReasoningEffort();
            if (reasoningEffort) {
              payload.options.modelReasoningEffort = reasoningEffort;
            } else {
              delete payload.options.modelReasoningEffort;
            }

            data = JSON.stringify(payload);
          }
        } catch (error) {
          console.warn("[mobile-codex] failed to patch websocket payload", error);
        }
      }

      return originalSend.call(this, data);
    };

    WebSocket.prototype.__mobileCodexPatched = true;
  }

  function install() {
    migrateDefaultCodexModel();
    patchWebSocketSend();
    patchCodexSelectors();

    var observer = new MutationObserver(function () {
      patchCodexSelectors();
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
