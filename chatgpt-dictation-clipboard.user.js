// ==UserScript==
// @name         ChatGPT Dictation Clipboard
// @namespace    https://github.com/
// @version      0.1.0
// @description  Copies ChatGPT dictation to the clipboard, clears the input, and plays a sound when it is ready.
// @author       Egorrko
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  const PREFIX = "[DictationClipboard]";
  const SETTINGS_KEY = "dictation-clipboard-enabled-v5";

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

  const TRANSCRIPTION_TIMEOUT_MS = 120_000;
  const HOTKEY_DEBOUNCE_MS = 600;

  let enabled = GM_getValue(SETTINGS_KEY, true);
  let recordingExpected = false;
  let textBeforeRecording = "";
  let operationId = 0;
  let lastHotkeyAt = 0;
  let audioContext = null;

  let panel;
  let statusDot;
  let statusText;
  let toggleButton;
  let timingText;

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

  function setStatus(text, state = "ready") {
    if (!statusText || !statusDot) {
      return;
    }

    statusText.textContent = text;
    statusDot.style.background = STATUS_COLORS[state] || STATUS_COLORS.ready;
    statusDot.style.boxShadow =
      state === "recording"
        ? `0 0 0 4px ${STATUS_COLORS.recording}33`
        : "none";
  }

  function updateToggle() {
    if (!toggleButton) {
      return;
    }

    toggleButton.textContent = enabled ? "On" : "Off";
    toggleButton.style.background = enabled ? "#10a37f" : "#52525b";
    toggleButton.setAttribute("aria-pressed", String(enabled));

    if (!enabled) {
      setStatus("Disabled", "disabled");
    } else if (!recordingExpected) {
      setStatus("Ready", "ready");
    }
  }

  function showToast(message, isError = false) {
    document.getElementById("dictation-clipboard-toast-v5")?.remove();

    const toast = document.createElement("div");
    toast.id = "dictation-clipboard-toast-v5";
    toast.textContent = message;

    Object.assign(toast.style, {
      position: "fixed",
      right: "18px",
      bottom: "280px",
      zIndex: "2147483647",
      maxWidth: "360px",
      padding: "10px 14px",
      borderRadius: "10px",
      background: isError ? "#7f1d1d" : "#18181b",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      fontWeight: "600",
      lineHeight: "1.4",
      boxShadow: "0 8px 30px rgba(0,0,0,.32)",
      pointerEvents: "none",
    });

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), isError ? 6000 : 2500);
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
            if (enabled && !recordingExpected) {
              setStatus("Ready", "ready");
            }
          }, 2500);

          return;
        }
      }

      await sleep(CHECK_INTERVAL_MS);
    }

    setStatus("Transcription not found", "error");
    showToast(
      "Recording stopped, but no new text appeared in the ChatGPT input.",
      true
    );
  }

  function handleRecordingStart() {
    operationId += 1;
    recordingExpected = true;
    textBeforeRecording = readComposerText();

    setStatus("Recording", "recording");
    log("START", { operationId, baseline: textBeforeRecording });
  }

  function handleRecordingStop() {
    recordingExpected = false;
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

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat || !isDictationHotkey(event)) {
        return;
      }

      // Do not block ChatGPT. This listener only watches the same shortcut.
      unlockAudio();

      if (!enabled) {
        return;
      }

      const now = Date.now();

      if (now - lastHotkeyAt < HOTKEY_DEBOUNCE_MS) {
        return;
      }

      lastHotkeyAt = now;

      if (recordingExpected) {
        handleRecordingStop();
      } else {
        handleRecordingStart();
      }
    },
    true
  );

  function makeRow(label, valueNode) {
    const row = document.createElement("div");

    Object.assign(row.style, {
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "14px",
      fontSize: "12px",
      lineHeight: "1.4",
    });

    const labelNode = document.createElement("span");
    labelNode.textContent = label;
    labelNode.style.color = "#a1a1aa";

    row.append(labelNode, valueNode);
    return row;
  }

  function createPanel() {
    document.getElementById("dictation-clipboard-panel-v5")?.remove();

    panel = document.createElement("section");
    panel.id = "dictation-clipboard-panel-v5";

    Object.assign(panel.style, {
      position: "fixed",
      right: "18px",
      bottom: "18px",
      zIndex: "2147483647",
      width: "282px",
      padding: "14px",
      border: "1px solid rgba(255,255,255,.12)",
      borderRadius: "14px",
      background: "rgba(24,24,27,.96)",
      color: "#fff",
      fontFamily: "system-ui, sans-serif",
      boxShadow: "0 12px 40px rgba(0,0,0,.38)",
      backdropFilter: "blur(12px)",
    });

    const header = document.createElement("div");
    Object.assign(header.style, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "12px",
      marginBottom: "12px",
    });

    const titleWrap = document.createElement("div");
    Object.assign(titleWrap.style, {
      display: "flex",
      alignItems: "center",
      gap: "9px",
      minWidth: "0",
    });

    const icon = document.createElement("span");
    icon.textContent = "📋";
    icon.style.fontSize = "20px";

    const title = document.createElement("strong");
    title.textContent = "Dictation Clipboard";
    Object.assign(title.style, {
      fontSize: "13px",
      whiteSpace: "nowrap",
    });

    titleWrap.append(icon, title);

    toggleButton = document.createElement("button");
    toggleButton.type = "button";

    Object.assign(toggleButton.style, {
      minWidth: "48px",
      height: "28px",
      padding: "0 11px",
      border: "0",
      borderRadius: "14px",
      color: "#fff",
      fontSize: "12px",
      fontWeight: "700",
      cursor: "pointer",
    });

    toggleButton.addEventListener("click", () => {
      unlockAudio();

      enabled = !enabled;
      GM_setValue(SETTINGS_KEY, enabled);

      operationId += 1;
      recordingExpected = false;

      updateToggle();
      showToast(enabled ? "Auto-copy enabled." : "Auto-copy disabled.");
    });

    header.append(titleWrap, toggleButton);

    const rows = document.createElement("div");
    Object.assign(rows.style, {
      display: "grid",
      gap: "8px",
    });

    const statusValue = document.createElement("span");
    Object.assign(statusValue.style, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "flex-end",
      gap: "7px",
      minWidth: "0",
      textAlign: "right",
    });

    statusDot = document.createElement("span");
    Object.assign(statusDot.style, {
      width: "8px",
      height: "8px",
      flex: "0 0 auto",
      borderRadius: "50%",
    });

    statusText = document.createElement("span");
    Object.assign(statusText.style, {
      color: "#f4f4f5",
      fontWeight: "600",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      maxWidth: "170px",
    });

    statusValue.append(statusDot, statusText);

    const shortcut = document.createElement("kbd");
    shortcut.textContent = "Ctrl + Shift + D";
    Object.assign(shortcut.style, {
      color: "#f4f4f5",
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: "11px",
      fontWeight: "700",
    });

    const behavior = document.createElement("span");
    behavior.textContent = "Copy · clear · sound";
    behavior.style.color = "#f4f4f5";

    timingText = document.createElement("span");
    timingText.textContent = `${TEXT_STABLE_MS} ms stable · ${CHECK_INTERVAL_MS} ms check`;
    Object.assign(timingText.style, {
      color: "#f4f4f5",
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: "10px",
    });

    rows.append(
      makeRow("Status", statusValue),
      makeRow("Shortcut", shortcut),
      makeRow("After recording", behavior),
      makeRow("Timing", timingText)
    );

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      gap: "8px",
      marginTop: "13px",
    });

    const copyNowButton = document.createElement("button");
    copyNowButton.type = "button";
    copyNowButton.textContent = "Copy current input";

    Object.assign(copyNowButton.style, {
      flex: "1",
      height: "32px",
      border: "1px solid rgba(255,255,255,.14)",
      borderRadius: "9px",
      background: "#27272a",
      color: "#fff",
      fontSize: "12px",
      fontWeight: "650",
      cursor: "pointer",
    });

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
        if (enabled && !recordingExpected) {
          setStatus("Ready", "ready");
        }
      }, 2500);
    });

    actions.append(copyNowButton);

    const note = document.createElement("div");
    note.textContent =
      "Stop the recording, switch apps, wait for the sound, then paste.";
    Object.assign(note.style, {
      marginTop: "11px",
      color: "#a1a1aa",
      fontSize: "11px",
      lineHeight: "1.4",
    });

    panel.append(header, rows, actions, note);
    document.body.appendChild(panel);

    updateToggle();
  }

  createPanel();

  // ChatGPT is a single-page app and may replace page nodes during navigation.
  setInterval(() => {
    if (!document.getElementById("dictation-clipboard-panel-v5")) {
      createPanel();
    }
  }, 2000);

  log("SCRIPT LOADED", {
    enabled,
    composerFound: Boolean(getComposer()),
    timing: {
      textStableMs: TEXT_STABLE_MS,
      checkIntervalMs: CHECK_INTERVAL_MS,
    },
  });

  showToast("Dictation Clipboard is ready.");
})();
