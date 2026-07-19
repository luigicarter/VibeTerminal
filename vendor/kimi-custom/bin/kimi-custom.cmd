@echo off
setlocal EnableExtensions

rem Force UTF-8 console output: legacy conhost windows default to the OEM code
rem page (usually 437), which renders the TUI's UTF-8 box-drawing as mojibake.
chcp 65001 >nul 2>&1

rem vibeTerminal vendored launcher for the custom Kimi Code fork
rem (claude-code profile set). Shares the standard kimi-code environment
rem (~/.kimi-code): login, theme, and session history carry over. Platform-key
rem mode (kimi-k3 on Moonshot's Anthropic-compatible endpoint, 1M context)
rem activates when a key is available — api.txt next to this package takes
rem precedence over KIMI_MODEL_API_KEY; with no key, the providers configured
rem in ~/.kimi-code apply (e.g. a Kimi Code subscription via `kimi-custom login`).

set "ROOT=%~dp0.."

if exist "%ROOT%\api.txt" (
	set "KIMI_API_TXT=%ROOT%\api.txt"
	for /f "delims=" %%k in ('node -e "process.stdout.write(require('fs').readFileSync(process.env.KIMI_API_TXT,'utf8').replace(/\s+/g,''))"') do set "KIMI_MODEL_API_KEY=%%k"
)

if defined KIMI_MODEL_API_KEY (
	if not defined KIMI_MODEL_PROVIDER_TYPE set "KIMI_MODEL_PROVIDER_TYPE=anthropic"
	if not defined KIMI_MODEL_BASE_URL set "KIMI_MODEL_BASE_URL=https://api.moonshot.ai/anthropic"
	if not defined KIMI_MODEL_NAME set "KIMI_MODEL_NAME=kimi-k3"
	if not defined KIMI_MODEL_MAX_CONTEXT_SIZE set "KIMI_MODEL_MAX_CONTEXT_SIZE=1048576"
) else (
	echo note: no api.txt / KIMI_MODEL_API_KEY - using providers configured in ~/.kimi-code 1>&2
)

if not defined VIBE_KIMI_CUSTOM_NODE set "VIBE_KIMI_CUSTOM_NODE=node"
rem Harmless for a real node binary; lets Electron's exe act as node when the
rem host found no Node.js install (last resort: Electron's GUI-subsystem exe
rem cannot attach to a ConPTY console on Windows, so the TUI degrades there).
set "ELECTRON_RUN_AS_NODE=1"

"%VIBE_KIMI_CUSTOM_NODE%" "%ROOT%\dist\main.mjs" %*
exit /b %ERRORLEVEL%
