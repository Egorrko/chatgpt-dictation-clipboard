// ==UserScript==
// @name         ChatGPT Dictation Clipboard
// @namespace    https://github.com/
// @version      0.4.0
// @description  Copies ChatGPT dictation to the clipboard, clears the input, and plays a sound when it is ready.
// @author       Egorrko
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-start
// ==/UserScript==

(() => {
  "use strict";

  const PREFIX = "[DictationClipboard]";
  const SETTINGS_KEY = "dictation-clipboard-enabled-v5";
  const POSITION_KEY = "dictation-clipboard-position-v1";
  const COLLAPSED_KEY = "dictation-clipboard-collapsed-v1";
  const HOST_ID = "dictation-clipboard-host-v6";
  const EDGE_GAP = 16;

  /*
   * Timing
   *
   * TEXT_STABLE_MS:
   * How long the transcription must stay unchanged before it is copied.
   *
   * CHECK_INTERVAL_MS:
   * How often the input is checked while waiting for the transcription.
   *
   * Fast default: about 100–150 ms after the final text appears.
   * Increase TEXT_STABLE_MS if partial transcriptions get copied.
   */
  const TEXT_STABLE_MS = 100;
  const CHECK_INTERVAL_MS = 50;

  // ChatGPT usually fills the input a second or two after the dictation
  // stops. A short timeout keeps a desynced state from hanging for minutes.
  const TRANSCRIPTION_TIMEOUT_MS = 15_000;
  const HOTKEY_DEBOUNCE_MS = 600;

  let enabled = GM_getValue(SETTINGS_KEY, true);
  let recording = false;
  let textBeforeRecording = "";
  let operationId = 0;
  let lastHotkeyAt = 0;
  let audioContext = null;

  let host;
  let root;
  let statusDot;
  let statusText;
  let toggleButton;
  let toastElement;
  let position = GM_getValue(POSITION_KEY, null);
  let collapsed = GM_getValue(COLLAPSED_KEY, false);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function log(...args) {
    console.log(PREFIX, ...args);
  }

  function normalizeText(text) {
    return String(text ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function getComposer() {
    return (
      document.querySelector("#prompt-textarea") ||
      document.querySelector('textarea[name="prompt-textarea"]') ||
      document.querySelector('[data-testid="composer-text-input"]') ||
      document.querySelector(
        'div[contenteditable="true"][data-virtualkeyboard="true"]'
      ) ||
      document.querySelector('form div[contenteditable="true"]')
    );
  }

  function readComposerText() {
    const composer = getComposer();

    if (!composer) {
      return "";
    }

    if (
      composer instanceof HTMLTextAreaElement ||
      composer instanceof HTMLInputElement
    ) {
      return normalizeText(composer.value);
    }

    return normalizeText(composer.innerText || composer.textContent || "");
  }

  function dispatchComposerInput(composer) {
    try {
      composer.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "deleteContentBackward",
          data: null,
        })
      );
    } catch {
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    }

    composer.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clearComposer(expectedText) {
    const composer = getComposer();

    if (!composer) {
      log("CLEAR FAILED: composer not found");
      return false;
    }

    if (readComposerText() !== normalizeText(expectedText)) {
      log("CLEAR SKIPPED: input changed after copy");
      return false;
    }

    if (
      composer instanceof HTMLTextAreaElement ||
      composer instanceof HTMLInputElement
    ) {
      const prototype =
        composer instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const setter = Object.getOwnPropertyDescriptor(
        prototype,
        "value"
      )?.set;

      if (setter) {
        setter.call(composer, "");
      } else {
        composer.value = "";
      }

      dispatchComposerInput(composer);
      return readComposerText() === "";
    }

    try {
      composer.focus({ preventScroll: true });

      const selection = window.getSelection();
      const range = document.createRange();

      range.selectNodeContents(composer);
      selection.removeAllRanges();
      selection.addRange(range);
      document.execCommand("delete", false);
      selection.removeAllRanges();
    } catch (error) {
      log("Native clear failed:", error);
    }

    if (readComposerText() !== "") {
      composer.innerHTML = "<p><br></p>";
      dispatchComposerInput(composer);
    }

    return readComposerText() === "";
  }

  function extractTranscription(before, after) {
    if (!before) {
      return after;
    }

    if (after.startsWith(before)) {
      return normalizeText(after.slice(before.length)) || after;
    }

    // ChatGPT may also adjust punctuation in existing text.
    // Copying the whole input is safer than losing part of the result.
    return after;
  }

  function copyText(text) {
    const normalized = normalizeText(text);

    if (!normalized) {
      return false;
    }

    try {
      GM_setClipboard(normalized, "text");
      log("COPIED", {
        length: normalized.length,
        preview: normalized.slice(0, 100),
      });
      return true;
    } catch (error) {
      console.error(PREFIX, "Clipboard error:", error);
      return false;
    }
  }

  function unlockAudio() {
    try {
      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      if (!AudioContextClass) {
        return;
      }

      if (!audioContext) {
        audioContext = new AudioContextClass();
      }

      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
    } catch (error) {
      log("Audio initialization failed:", error);
    }
  }

  function playTone(frequency, startOffset, duration, volume) {
    if (!audioContext) {
      return;
    }

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const startAt = audioContext.currentTime + startOffset;
    const endAt = startAt + duration;

    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, startAt);

    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

    oscillator.connect(gain);
    gain.connect(audioContext.destination);

    oscillator.start(startAt);
    oscillator.stop(endAt + 0.02);
  }

  function playSuccessSound() {
    unlockAudio();

    if (!audioContext) {
      return;
    }

    playTone(660, 0, 0.1, 0.12);
    playTone(880, 0.11, 0.16, 0.14);
  }

  const STATUS_COLORS = {
    ready: "#22c55e",
    recording: "#ef4444",
    waiting: "#f59e0b",
    success: "#3b82f6",
    disabled: "#71717a",
    error: "#dc2626",
  };

  let toastTimer = 0;

  function setStatus(text, state = "ready") {
    if (!statusText || !statusDot) {
      return;
    }

    statusText.textContent = text;
    statusDot.style.setProperty(
      "--dot",
      STATUS_COLORS[state] || STATUS_COLORS.ready
    );
    statusDot.classList.toggle("is-pulsing", state === "recording");
  }

  function updateToggle() {
    if (!toggleButton) {
      return;
    }

    toggleButton.setAttribute("aria-pressed", String(enabled));
    toggleButton.title = enabled ? "Auto-copy is on" : "Auto-copy is off";

    if (!enabled) {
      setStatus("Disabled", "disabled");
    } else if (!recording) {
      setStatus("Ready", "ready");
    }
  }

  function showToast(message, isError = false) {
    if (!toastElement) {
      return;
    }

    clearTimeout(toastTimer);

    toastElement.textContent = message;
    toastElement.classList.toggle("is-error", isError);
    toastElement.classList.add("is-visible");

    toastTimer = setTimeout(
      () => toastElement.classList.remove("is-visible"),
      isError ? 6000 : 2500
    );
  }

  async function waitForTranscription(baseline, currentOperationId) {
    setStatus("Waiting for transcription", "waiting");

    const startedAt = Date.now();
    let candidate = "";
    let candidateSince = 0;

    while (Date.now() - startedAt < TRANSCRIPTION_TIMEOUT_MS) {
      if (!enabled || currentOperationId !== operationId) {
        return;
      }

      const current = readComposerText();

      if (current && current !== baseline) {
        if (current !== candidate) {
          candidate = current;
          candidateSince = Date.now();
        } else if (Date.now() - candidateSince >= TEXT_STABLE_MS) {
          const transcription = extractTranscription(baseline, current);

          if (!copyText(transcription)) {
            setStatus("Clipboard error", "error");
            showToast(
              "The transcription appeared, but copying failed. The input was not cleared.",
              true
            );
            return;
          }

          const cleared = clearComposer(current);
          playSuccessSound();

          setStatus(
            cleared
              ? `Copied and cleared · ${transcription.length} chars`
              : `Copied · ${transcription.length} chars`,
            "success"
          );

          showToast(
            cleared
              ? "Copied to the clipboard. The input is ready for the next dictation."
              : "Copied to the clipboard, but the input could not be cleared."
          );

          setTimeout(() => {
            if (enabled && !recording) {
              setStatus("Ready", "ready");
            }
          }, 2500);

          return;
        }
      }

      await sleep(CHECK_INTERVAL_MS);
    }

    setStatus("No transcription", "error");
    showToast(
      "No new text appeared in the ChatGPT input. If ChatGPT was still recording, press the shortcut again.",
      true
    );

    setTimeout(() => {
      if (enabled && !recording) {
        setStatus("Ready", "ready");
      }
    }, 2500);
  }

  function handleRecordingStart() {
    operationId += 1;
    recording = true;
    textBeforeRecording = readComposerText();

    setStatus("Recording", "recording");
    log("START", { operationId, baseline: textBeforeRecording });
  }

  function handleRecordingStop() {
    recording = false;
    const currentOperationId = operationId;

    setStatus("Processing", "waiting");
    log("STOP", { operationId });

    waitForTranscription(textBeforeRecording, currentOperationId).catch(
      (error) => {
        console.error(PREFIX, error);
        setStatus("Unexpected error", "error");
        showToast("Could not wait for the transcription.", true);
      }
    );
  }

  function isDictationHotkey(event) {
    return (
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      event.code === "KeyD"
    );
  }

  // ChatGPT matches its own shortcut on event.key, which is "в" on a Russian
  // layout, so replay the event as a Latin "d" for it.
  function replayAsLatin() {
    const target = getComposer() || document.activeElement || document.body;

    target.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        code: "KeyD",
        keyCode: 68,
        which: 68,
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  }

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || !isDictationHotkey(event)) {
        return;
      }

      unlockAudio();

      if (!enabled) {
        return;
      }

      const now = Date.now();

      if (now - lastHotkeyAt < HOTKEY_DEBOUNCE_MS) {
        return;
      }

      lastHotkeyAt = now;

      if (event.key.toLowerCase() !== "d") {
        // ChatGPT never sees this one anyway, so the browser action
        // (Yandex/Chrome: "bookmark all tabs") can be dropped safely.
        // preventDefault() on a Latin "d" would break ChatGPT's own handler,
        // which ignores events that are already default-prevented.
        event.preventDefault();
        replayAsLatin();
      }

      if (recording) {
        handleRecordingStop();
      } else {
        handleRecordingStart();
      }
    },
    true
  );

  const PANEL_CSS = `
    .root {
      --bg: rgba(24, 24, 27, .72);
      --border: rgba(255, 255, 255, .10);
      --fg: #fafafa;
      --muted: #a1a1aa;
      --surface: rgba(255, 255, 255, .07);
      --surface-hover: rgba(255, 255, 255, .12);
      --accent: #10a37f;
      position: relative;
      display: block;
      width: max-content;
      color: var(--fg);
      font: 500 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    .root.is-light {
      --bg: rgba(255, 255, 255, .78);
      --border: rgba(0, 0, 0, .09);
      --fg: #18181b;
      --muted: #71717a;
      --surface: rgba(0, 0, 0, .05);
      --surface-hover: rgba(0, 0, 0, .09);
    }

    .card {
      width: 276px;
      border: 1px solid var(--border);
      border-radius: 18px;
      background: var(--bg);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      box-shadow: 0 1px 2px rgba(0, 0, 0, .16), 0 16px 40px -12px rgba(0, 0, 0, .45);
      overflow: hidden;
      transition: width .2s ease;
    }

    .root.is-collapsed .card { width: auto; }
    .root.is-collapsed .body { display: none; }

    .header {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 10px 10px 10px 13px;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }

    .header.is-dragging { cursor: grabbing; }

    .dot {
      width: 9px;
      height: 9px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--dot, #22c55e);
    }

    .dot.is-pulsing { animation: pulse 1.5s ease-out infinite; }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--dot) 55%, transparent); }
      70% { box-shadow: 0 0 0 7px transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }

    .status {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
      letter-spacing: -.01em;
    }

    .root.is-collapsed .status { max-width: 132px; }

    .switch {
      position: relative;
      width: 34px;
      height: 20px;
      flex: 0 0 auto;
      padding: 0;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface);
      cursor: pointer;
      transition: background .18s ease, border-color .18s ease;
    }

    .switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0, 0, 0, .3);
      transition: transform .18s ease;
    }

    .switch[aria-pressed="true"] {
      background: var(--accent);
      border-color: transparent;
    }

    .switch[aria-pressed="true"]::after { transform: translateX(14px); }

    .icon-button {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      padding: 0;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      transition: background .15s ease, color .15s ease, transform .2s ease;
    }

    .icon-button:hover {
      background: var(--surface-hover);
      color: var(--fg);
    }

    .root.is-collapsed .chevron { transform: rotate(180deg); }

    .body {
      display: grid;
      gap: 7px;
      padding: 2px 13px 13px;
    }

    .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      font-size: 12px;
    }

    .row > .label {
      color: var(--muted);
      font-weight: 500;
    }

    .row > .value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    kbd, .mono {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
    }

    kbd {
      padding: 2px 6px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface);
      font-weight: 600;
    }

    .warn { color: #f59e0b; }

    .button {
      height: 32px;
      margin-top: 5px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
      color: var(--fg);
      font: 600 12px system-ui, -apple-system, "Segoe UI", sans-serif;
      cursor: pointer;
      transition: background .15s ease;
    }

    .button:hover { background: var(--surface-hover); }
    .button:active { transform: translateY(1px); }

    .hint {
      color: var(--muted);
      font-size: 11px;
      font-weight: 500;
    }

    .toast {
      position: absolute;
      right: 0;
      bottom: calc(100% + 9px);
      width: max-content;
      max-width: 300px;
      padding: 9px 12px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: var(--bg);
      backdrop-filter: blur(24px) saturate(180%);
      -webkit-backdrop-filter: blur(24px) saturate(180%);
      box-shadow: 0 12px 32px -10px rgba(0, 0, 0, .5);
      font-size: 12.5px;
      font-weight: 500;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity .2s ease, transform .2s ease;
      pointer-events: none;
    }

    .toast.is-visible {
      opacity: 1;
      transform: none;
    }

    .toast.is-error {
      background: #7f1d1d;
      border-color: rgba(255, 255, 255, .16);
      color: #fff;
    }

    .root.is-flipped .toast {
      bottom: auto;
      top: calc(100% + 9px);
      transform: translateY(-4px);
    }

    .root.is-flipped .toast.is-visible { transform: none; }

    @media (prefers-reduced-motion: reduce) {
      * { transition: none !important; animation: none !important; }
    }
  `;

  function makeRow(label, valueNode) {
    const row = document.createElement("div");
    row.className = "row";

    const labelNode = document.createElement("span");
    labelNode.className = "label";
    labelNode.textContent = label;

    valueNode.classList.add("value");
    row.append(labelNode, valueNode);

    return row;
  }

  // ChatGPT keeps its own theme in the html class list, which may differ
  // from the system one.
  function syncTheme() {
    if (!root) {
      return;
    }

    const classList = document.documentElement.classList;
    const dark = classList.contains("dark")
      ? true
      : classList.contains("light")
      ? false
      : window.matchMedia("(prefers-color-scheme: dark)").matches;

    root.classList.toggle("is-light", !dark);
  }

  function setPosition(left, top) {
    const rect = host.getBoundingClientRect();
    const maxLeft = Math.max(EDGE_GAP, window.innerWidth - rect.width - EDGE_GAP);
    const maxTop = Math.max(EDGE_GAP, window.innerHeight - rect.height - EDGE_GAP);

    position = {
      left: Math.min(Math.max(EDGE_GAP, left), maxLeft),
      top: Math.min(Math.max(EDGE_GAP, top), maxTop),
    };

    host.style.left = `${position.left}px`;
    host.style.top = `${position.top}px`;

    // Flip the toast below the card when there is no room above it.
    root.classList.toggle("is-flipped", position.top < 120);
  }

  function makeDraggable(handle) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) {
        return;
      }

      const rect = host.getBoundingClientRect();
      const grabX = event.clientX - rect.left;
      const grabY = event.clientY - rect.top;

      const move = (moveEvent) =>
        setPosition(moveEvent.clientX - grabX, moveEvent.clientY - grabY);

      const drop = () => {
        handle.removeEventListener("pointermove", move);
        handle.classList.remove("is-dragging");
        GM_setValue(POSITION_KEY, position);
      };

      handle.setPointerCapture(event.pointerId);
      handle.classList.add("is-dragging");
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", drop, { once: true });
      handle.addEventListener("pointercancel", drop, { once: true });

      event.preventDefault();
    });
  }

  function createPanel() {
    document.getElementById(HOST_ID)?.remove();

    host = document.createElement("div");
    host.id = HOST_ID;
    Object.assign(host.style, {
      position: "fixed",
      left: "0px",
      top: "0px",
      zIndex: "2147483647",
    });

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;

    root = document.createElement("div");
    root.className = "root";
    root.classList.toggle("is-collapsed", collapsed);

    toastElement = document.createElement("div");
    toastElement.className = "toast";
    toastElement.setAttribute("role", "status");

    const card = document.createElement("section");
    card.className = "card";

    const header = document.createElement("div");
    header.className = "header";
    header.title = "Drag to move";

    statusDot = document.createElement("span");
    statusDot.className = "dot";

    statusText = document.createElement("span");
    statusText.className = "status";

    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = "switch";
    toggleButton.addEventListener("click", () => {
      unlockAudio();

      enabled = !enabled;
      GM_setValue(SETTINGS_KEY, enabled);

      // Doubles as a state reset: cancels a pending wait and clears the
      // recording flag if it ever gets out of sync with ChatGPT.
      operationId += 1;
      recording = false;

      updateToggle();
      showToast(enabled ? "Auto-copy enabled." : "Auto-copy disabled.");
    });

    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "icon-button";
    collapseButton.innerHTML =
      '<svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    collapseButton.addEventListener("click", () => {
      collapsed = !collapsed;
      GM_setValue(COLLAPSED_KEY, collapsed);

      root.classList.toggle("is-collapsed", collapsed);
      collapseButton.title = collapsed ? "Expand" : "Collapse";

      // Width changed, so the card may now stick out of the viewport.
      setPosition(position.left, position.top);
    });
    collapseButton.title = collapsed ? "Expand" : "Collapse";

    header.append(statusDot, statusText, toggleButton, collapseButton);

    const body = document.createElement("div");
    body.className = "body";

    const shortcut = document.createElement("kbd");
    shortcut.textContent = "Ctrl + Shift + D";

    const timing = document.createElement("span");
    timing.className = "mono";
    timing.textContent = `${TEXT_STABLE_MS} ms · ${CHECK_INTERVAL_MS} ms`;

    const copyNowButton = document.createElement("button");
    copyNowButton.type = "button";
    copyNowButton.className = "button";
    copyNowButton.textContent = "Copy current input";
    copyNowButton.addEventListener("click", () => {
      unlockAudio();

      const text = readComposerText();

      if (!copyText(text)) {
        setStatus("Input is empty", "error");
        showToast("There is no text to copy.", true);
        return;
      }

      playSuccessSound();
      setStatus(`Copied manually · ${text.length} chars`, "success");
      showToast("Current ChatGPT input copied.");

      setTimeout(() => {
        if (enabled && !recording) {
          setStatus("Ready", "ready");
        }
      }, 2500);
    });

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Stop the dictation, switch apps, wait for the sound, paste.";

    body.append(
      makeRow("Shortcut", shortcut),
      makeRow("Timing", timing),
      copyNowButton,
      hint
    );

    card.append(header, body);
    root.append(toastElement, card);
    shadow.append(style, root);
    document.body.appendChild(host);

    makeDraggable(header);
    syncTheme();

    const rect = host.getBoundingClientRect();
    setPosition(
      position?.left ?? window.innerWidth - rect.width - EDGE_GAP,
      position?.top ?? window.innerHeight - rect.height - EDGE_GAP
    );

    updateToggle();

    if (recording) {
      setStatus("Recording", "recording");
    }
  }

  function init() {
    createPanel();

    // ChatGPT is a single-page app and may replace page nodes during navigation.
    setInterval(() => {
      if (document.getElementById(HOST_ID)) {
        syncTheme();
      } else {
        createPanel();
      }
    }, 2000);

    window.addEventListener("resize", () =>
      setPosition(position.left, position.top)
    );

    log("SCRIPT LOADED", {
      enabled,
      composerFound: Boolean(getComposer()),
      timing: {
        textStableMs: TEXT_STABLE_MS,
        checkIntervalMs: CHECK_INTERVAL_MS,
      },
    });

    showToast("Dictation Clipboard is ready.");
  }

  if (document.body) {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
})();
