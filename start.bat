@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem ---- resolve node.exe ----
rem Node is not always on PATH (the DSH bundled runtime is a common case). Resolving it
rem here keeps the documented "double-click start.bat" flow working, and also keeps
rem restart.bat (which relaunches this file) from spinning on a missing command.
rem Precedence: explicit NODE_EXE env var > node on PATH > node bundled with a DSH runtime.
rem No absolute machine paths are hardcoded: the DSH runtime is located through
rem %USERPROFILE% / %LOCALAPPDATA%, so this file stays portable (and privacy-clean).
set "NODE_EXE_PREF=%NODE_EXE%"
set "NODE_EXE="
if defined NODE_EXE_PREF if exist "%NODE_EXE_PREF%" set "NODE_EXE=%NODE_EXE_PREF%"
if not defined NODE_EXE (
    where node >nul 2>nul
    if not errorlevel 1 set "NODE_EXE=node"
)
if not defined NODE_EXE call :find_dsh_node "%USERPROFILE%\.dsh\dsh-runtimes"
if not defined NODE_EXE call :find_dsh_node "%LOCALAPPDATA%\.dsh\dsh-runtimes"
if not defined NODE_EXE (
    echo [%date% %time%] node.exe not found. Install Node.js 22.13+ or set NODE_EXE to its full path.
    pause
    exit /b 1
)
echo [%date% %time%] node: %NODE_EXE%
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
"%NODE_EXE%" scripts\harden-state-acl.mjs --quiet
:loop
"%NODE_EXE%" src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    echo [%date% %time%] bridge already running in another window. Exiting.
    pause
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto loop

:find_dsh_node
rem %1 = "<...>\.dsh\dsh-runtimes" - pick the first *\dependencies\node\bin\node.exe.
if not exist "%~1" exit /b 0
for /d %%R in ("%~1\*") do (
    if not defined NODE_EXE if exist "%%~fR\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fR\dependencies\node\bin\node.exe"
)
exit /b 0
