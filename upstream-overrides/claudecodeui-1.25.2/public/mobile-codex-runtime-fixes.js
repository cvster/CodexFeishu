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

  function removeInjectedReasoningWrappers() {
    document.querySelectorAll('[data-mobile-codex-reasoning="true"]').forEach(function (wrapper) {
      wrapper.remove();
    });
  }

  function patchCodexSelectors() {
    removeInjectedReasoningWrappers();

    var selects = document.querySelectorAll("select");
    selects.forEach(function (select) {
      if (!isCodexModelSelect(select)) {
        return;
      }

      ensureCodexModelOption(select);
      syncCodexModelSelection(select);
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
