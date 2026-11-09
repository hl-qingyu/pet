@echo off
cd /d "%~dp0"
if exist "%~dp0dist\win-unpacked\DragonDesk.exe" (
  start "" "%~dp0dist\win-unpacked\DragonDesk.exe" "--config=%~dp0config.json"
) else if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0" "--config=%~dp0config.json"
) else (
  echo Please run npm install first.
  pause
)
