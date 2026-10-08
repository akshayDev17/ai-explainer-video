# Setup — what this skill needs on the machine

One-time environment prerequisites. `SKILL.md` and the per-stage files point here; run
everything else from the skill folder (where `tools/` lives). Everything the pipeline
produces beyond this it makes itself under `out/`.

## Node ≥ 22

`render.mjs` and `debug-page.mjs` rely on Node's built-in global `WebSocket`. Nothing
declares it, so on older Node it fails cryptically. Check with `node --version`.

## ffmpeg + ffprobe

Frame → H.264 encoding, muxing, and the `ffprobe` duration measurement. Both must be on
`PATH`.

## Headless Chromium

The render stage captures frames through the headless shell. One command covers all three
OSes; Playwright puts the binary in the per-OS cache folder:

```bash
npx playwright install --with-deps --only-shell
```

- `--only-shell` downloads just the headless shell, not the full Chromium browser.
- `--with-deps` also installs the OS system libraries — needed on a bare Linux box; on
  macOS and Windows there are no extra dependencies to install.

`tools/chromium.mjs` finds it in the cache — `~/Library/Caches/ms-playwright` (macOS) ·
`~/.cache/ms-playwright` (Linux) · `%LOCALAPPDATA%\ms-playwright` (Windows) — or honours
`CHROME_BIN` / `PLAYWRIGHT_BROWSERS_PATH` if the browser lives somewhere else.

([source](https://playwright.dev/docs/browsers#chromium-headless-shell))

## Gemini API key

Read from the OS's native secret store — **never env, never a plaintext file**. Store it
once (a free key: <https://aistudio.google.com/apikey>).

**macOS — Keychain.** Either way stores the same item:

- GUI: **Keychain Access** (Applications → Utilities) → File → **New Password Item…** →
  *Keychain Item Name* `gemini-tts` · *Account Name* your username · *Password* the key →
  **Add**. ([source](https://its.uiowa.edu/services/macos/how-use-keychain-access-macos))
- CLI: `security add-generic-password -U -s gemini-tts -a "$USER" -w` (prompts for the key).

The script looks the item up by its **service** attribute, which the GUI dialog does not
expose. After creating it in the GUI, verify with `security find-generic-password -s
gemini-tts -w`; if that prints nothing, use the CLI command instead.

**Linux — Secret Service.** Either way:

- GUI: **Passwords and Keys** (Seahorse) → **+** → **Password** → pick a keyring, put
  `gemini-tts` in *Description* and the key in *Password* → **Add**.
  ([source](https://help.gnome.org/seahorse/passwords-stored-create.html))
- CLI: `secret-tool store --label="Gemini TTS" service gemini-tts` (reads the key from
  stdin — paste it, then Ctrl-D).

Same caveat: the GUI stores a *Description*, not the `service` attribute the script keys
on. Verify with `secret-tool lookup service gemini-tts`; if empty, use the CLI.

**Windows — Credential Manager** (GUI only — there is no command-line store, and the
pipeline reads the credential with the Windows CredMan API):

Control Panel → **User Accounts** → **Credential Manager** → **Windows Credentials** →
**Add a generic credential** → *Internet or network address* `gemini-tts` · *User name*
anything (e.g. your username) · *Password* the key → **OK**.

([Credential Manager in Windows](https://support.microsoft.com/en-us/windows/security/credential-manager-in-windows) ·
[CredRead — the retrieval API](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw))

One-off override: `--key <value>` on any tool — visible in the process list, so not for
everyday use.
