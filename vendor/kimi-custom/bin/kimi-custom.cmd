@echo off
setlocal EnableExtensions

rem vibeTerminal vendored launcher for the custom Kimi Code fork
rem (kimi-k3 on Moonshot's Anthropic-compatible endpoint, claude-code profile set).

set "ROOT=%~dp0.."

rem Isolated config/session home. vibeTerminal injects KIMI_CODE_HOME per pane
rem (app-owned dir under userData); standalone runs fall back to a per-user dir.
if not defined KIMI_CODE_HOME set "KIMI_CODE_HOME=%USERPROFILE%\.kimi-code-custom"

rem Model defaults (all overridable from the environment).
if not defined KIMI_MODEL_PROVIDER_TYPE set "KIMI_MODEL_PROVIDER_TYPE=anthropic"
if not defined KIMI_MODEL_BASE_URL set "KIMI_MODEL_BASE_URL=https://api.moonshot.ai/anthropic"
if not defined KIMI_MODEL_NAME set "KIMI_MODEL_NAME=kimi-k3"
if not defined KIMI_MODEL_MAX_CONTEXT_SIZE set "KIMI_MODEL_MAX_CONTEXT_SIZE=1048576"

rem API key: an existing env var wins; otherwise read the gitignored api.txt next
rem to this package (copy it there once — it is never committed to the repo).
if not defined KIMI_MODEL_API_KEY if exist "%ROOT%\api.txt" (
	set "KIMI_API_TXT=%ROOT%\api.txt"
	for /f "delims=" %%k in ('node -e "process.stdout.write(require('fs').readFileSync(process.env.KIMI_API_TXT,'utf8').replace(/\s+/g,''))"') do set "KIMI_MODEL_API_KEY=%%k"
)

if not defined VIBE_KIMI_CUSTOM_NODE set "VIBE_KIMI_CUSTOM_NODE=node"
rem Harmless for a real node binary; lets Electron's exe act as node when packaged.
set "ELECTRON_RUN_AS_NODE=1"

"%VIBE_KIMI_CUSTOM_NODE%" "%ROOT%\dist\main.mjs" %*
exit /b %ERRORLEVEL%
