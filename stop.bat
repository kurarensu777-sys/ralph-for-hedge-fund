@echo off
rem stop.bat - stop the fund, in order: the cockpit, then Postgres LAST (the cockpit may still be
rem writing to it).
rem   stop.bat            all of it, in that order
rem   stop.bat --all      the same
rem   stop.bat --cockpit  the cockpit only (:4688, the dev fundd :4689, the prod fundd pid);
rem                       Postgres stays up (start.bat uses this to clear an orphaned dev fundd)
rem Every listener is killed WITH ITS TREE (taskkill /T /F): agents and workers are children.
rem Postgres is stopped cleanly by database\scripts\pg.py stop (pg_ctl -m fast), never killed.
setlocal
set "ROOT=%~dp0"
set "MODE=all"
if /i "%~1"=="--cockpit" set "MODE=cockpit"
set "PY=%ROOT%.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

rem ---- 1. the cockpit: the prod fundd stops itself by its pid file, then its ports ----
if exist "%ROOT%app\scripts\prod.mjs" node "%ROOT%app\scripts\prod.mjs" --stop
for %%p in (4688 4689) do call :stop %%p
if "%MODE%"=="cockpit" goto :done

rem ---- 2. Postgres, last ----
if exist "%ROOT%database\scripts\pg.py" (
  "%PY%" "%ROOT%database\scripts\pg.py" stop
) else (
  echo [fund] no database\scripts\pg.py - Postgres left as it is
)

:done
echo [fund] down.
exit /b 0

:stop
set "PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:%1 .*LISTENING" /c:"0\.0\.0\.0:%1 .*LISTENING" /c:"\[::1\]:%1 .*LISTENING" /c:"\[::\]:%1 .*LISTENING"') do set "PID=%%a"
if not defined PID (
  echo [fund] :%1 free
  exit /b 0
)
echo [fund] :%1 stopping pid %PID% and its tree
rem npm run dev puts the port holder under a `cmd /c vite` wrapper: kill the wrapper's tree too
set "WRAP=0"
for /f "usebackq" %%q in (`powershell -NoProfile -Command "$h=Get-CimInstance Win32_Process -Filter 'ProcessId=%PID%'; $w=Get-CimInstance Win32_Process -Filter ('ProcessId='+$h.ParentProcessId); if ($w -and $w.Name -eq 'cmd.exe' -and $w.CommandLine -match '/[ck] (vite|npm run dev)') { $w.ProcessId } else { 0 }"`) do set "WRAP=%%q"
if not "%WRAP%"=="0" taskkill /PID %WRAP% /T /F >nul 2>&1
rem npm run dev runs fundd under `tsx watch` (app\scripts\dev.mjs): the watcher is the holder's
rem ancestor and outlives it, and the next edit under app\server brings an orphan fundd back on
rem :4689. Kill the TOPMOST `tsx ... watch` ancestor's tree (the cmd /c and npx layers match too),
rem walking at most 6 parents up and never past the first ancestor that does not match
set "SUP=0"
for /f "usebackq" %%q in (`powershell -NoProfile -Command "$p=%PID%; $top=0; for($i=0; $i -lt 6; $i++){ $h=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p); if(-not $h){break}; $a=Get-CimInstance Win32_Process -Filter ('ProcessId='+$h.ParentProcessId); if(-not $a -or $a.CommandLine -notmatch 'tsx\S*\s+watch\b'){break}; $top=$a.ProcessId; $p=$a.ProcessId }; $top"`) do set "SUP=%%q"
if not "%SUP%"=="0" (
  echo [fund] :%1 its tsx watch supervisor pid %SUP% goes too
  taskkill /PID %SUP% /T /F >nul 2>&1
)
taskkill /PID %PID% /T /F >nul 2>&1
rem a supervisor (a reloader) respawns the holder: if the port comes back, kill its parent's tree
ping -n 2 127.0.0.1 >nul
set "PID2="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr /r /c:"127\.0\.0\.1:%1 .*LISTENING" /c:"0\.0\.0\.0:%1 .*LISTENING"') do set "PID2=%%a"
if defined PID2 (
  for /f "usebackq" %%q in (`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=%PID2%').ParentProcessId"`) do taskkill /PID %%q /T /F >nul 2>&1
  taskkill /PID %PID2% /T /F >nul 2>&1
)
exit /b 0
