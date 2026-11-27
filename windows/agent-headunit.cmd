@echo off
setlocal
if not defined ANDROID_HOME set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
set "PATH=%ANDROID_HOME%\platform-tools;%ANDROID_HOME%\emulator;%~dp0.runtime\python\Scripts;%~dp0.runtime\node_modules\.bin;%PATH%"
set "AGENT_DEVICE_HOME=%~dp0.runtime\home"
set "AGENT_DEVICE_STATE_DIR=%~dp0.runtime\daemon"
if not defined AGENT_DEVICE_SESSION set "AGENT_DEVICE_SESSION=headunit"
if not exist "%~dp0.runtime\node_modules\agent-device\bin\agent-device.mjs" (
  echo Run setup.py in the extracted release folder first. 1>&2
  exit /b 1
)
node "%~dp0.runtime\node_modules\agent-device\bin\agent-device.mjs" %*
exit /b %errorlevel%
