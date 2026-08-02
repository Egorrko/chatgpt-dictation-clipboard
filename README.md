# ChatGPT Dictation Clipboard

Use ChatGPT dictation anywhere.

Stop recording, switch to another app, wait for the sound, then paste. The script automatically copies the transcription and clears the ChatGPT input.

## Install

### 1. Install a userscript manager

[Install Tampermonkey](https://www.tampermonkey.net/) — recommended.

[Install Violentmonkey](https://violentmonkey.github.io/get-it/) — free alternative.

### 2. Install the script

[![Install userscript](https://img.shields.io/badge/Install-userscript-10a37f?style=for-the-badge)](https://github.com/Egorrko/chatgpt-dictation-clipboard/raw/refs/heads/main/chatgpt-dictation-clipboard.user.js)

Your userscript manager will open an installation page. Click **Install**.

## Use

1. Open [ChatGPT](https://chatgpt.com/).
2. Press `Ctrl + Shift + D`.
3. Speak.
4. Press `Ctrl + Shift + D` again.
5. Switch to another app.
6. Wait for the sound and paste with `Ctrl + V`.

The ChatGPT input is cleared after a successful copy.

## Timing

These values control how quickly the transcription is copied:

```js
const TEXT_STABLE_MS = 100;
const CHECK_INTERVAL_MS = 50;
```

Lower values copy sooner. Increase `TEXT_STABLE_MS` if an incomplete transcription gets copied.
