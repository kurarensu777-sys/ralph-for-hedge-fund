@echo off
rem Start the fund cockpit in PRODUCTION mode: build the UI when it is stale, then run ONE detached
rem fundd that serves the UI and the API on :4688. Safe to run twice: a cockpit already up (prod, or
rem npm run dev) is adopted, never restarted. The window can close; fundd keeps running.
rem   start.cmd             start (or adopt) and open the browser
rem   start.cmd --no-open   start only
rem   start.cmd --status    what is running
rem   start.cmd --stop      ask the prod fundd to leave (refused while work runs; --stop --force cuts it)
rem   start.cmd --foreground  run fundd in THIS window (the fund root's start.bat uses it)
rem Development is still: npm run dev  (fundd :4689 + vite :4688)
setlocal
cd /d "%~dp0"
node scripts\prod.mjs %*
exit /b %errorlevel%
