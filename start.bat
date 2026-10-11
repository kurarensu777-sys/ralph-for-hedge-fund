@echo off
rem start.bat - bring the fund up: set the machine up when anything is missing, start the data
rem layer (Postgres, migrations applied), then the cockpit in ONE console window titled "fund".
rem   start.bat            set up if needed, start Postgres, start the cockpit, open http://127.0.0.1:4688/
rem   start.bat --no-open  the same, no browser
rem   start.bat --setup    run the setup step even when nothing looks missing
rem First run on a new machine: clone the repo, run start.bat. Setup creates .venv at the root,
rem installs fund_db into it (pip install -e database[test]), then the node packages of
rem database\node and app\. Postgres is installed and initialised by database\scripts\pg.py
rem (portable, no admin, 127.0.0.1 only, no password). Closing the "fund" window stops the
rem cockpit; stop.bat stops everything, Postgres last.
setlocal
set "ROOT=%~dp0"
set "APP=%ROOT%app"
set "PY=%ROOT%.venv\Scripts\python.exe"
set "URL=http://127.0.0.1:4688/"
set "SETUP=0"
set "OPEN="
:args
if "%~1"=="" goto :argsdone
if /i "%~1"=="--setup" set "SETUP=1"
if /i "%~1"=="--no-open" set "OPEN=--no-open"
shift
goto :args
:argsdone

rem ---- 1. set up when anything is missing ----
if not exist "%PY%" set "SETUP=1"
if not exist "%APP%\node_modules" set "SETUP=1"
if not exist "%ROOT%database\node\node_modules" set "SETUP=1"
if "%SETUP%"=="1" call :setup || exit /b 1

rem ---- 2. the data layer: Postgres up, then every pending migration applied ----
echo [fund] data layer: database\scripts\pg.py ensure
"%PY%" "%ROOT%database\scripts\pg.py" ensure --no-migrate || (
  echo [fund] Postgres did not start - fix the line above, then run start.bat again
  exit /b 1
)
"%PY%" -m fund_db migrate || (
  echo [fund] a migration failed - fix the line above, then run start.bat again
  exit /b 1
)

rem ---- 3. the cockpit ----
curl -sf -m 3 -o nul %URL%api/health && goto :up
rem a dev fundd left on :4689 with no UI on :4688 is an orphan (its vite is gone) and would make
rem prod refuse to start (two schedulers on one ~/fund-data): stop it first, and ONLY it - the
rem data layer stays up
curl -sf -m 3 -o nul http://127.0.0.1:4689/api/health && (
  echo [fund] stopping an orphaned dev fundd on :4689
  call "%ROOT%stop.bat" --cockpit >nul
)
start "fund" /D "%APP%" cmd /k "title fund && node scripts\prod.mjs --foreground %OPEN%"
echo [fund] starting in the "fund" window: %URL%
exit /b 0

:up
echo [fund] already up: %URL%
if not defined OPEN start "" %URL%
exit /b 0

:setup
echo [fund] setting up this machine
if exist "%PY%" goto :pip
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" || (
  echo [fund] setup: Python 3.12 or newer must be on PATH as python
  exit /b 1
)
echo [fund] setup: creating .venv
python -m venv "%ROOT%.venv" || (
  echo [fund] setup: creating .venv failed - fix the line above, then run start.bat again
  exit /b 1
)
:pip
echo [fund] setup: pip install -e database[test]
"%PY%" -m pip install -e "%ROOT%database[test]" || (
  echo [fund] setup: pip install failed - fix the line above, then run start.bat again
  exit /b 1
)
echo [fund] setup: pip install -e platform
"%PY%" -m pip install -e "%ROOT%platform" || (
  echo [fund] setup: pip install of platform failed - fix the line above, then run start.bat again
  exit /b 1
)
echo [fund] setup: npm install in database\node
call npm install --prefix "%ROOT%database\node" || (
  echo [fund] setup: npm install in database\node failed - fix the line above, then run start.bat again
  exit /b 1
)
echo [fund] setup: npm install in app
pushd "%APP%"
call npm install
if errorlevel 1 (
  popd
  echo [fund] setup: npm install in app failed - fix the line above, then run start.bat again
  exit /b 1
)
popd
exit /b 0
