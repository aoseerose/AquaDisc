@echo off
title AquaDisc
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js n'est pas installe sur ce PC.
  echo   Telecharge-le sur https://nodejs.org  puis relance LANCER.bat
  echo.
  pause
  exit /b 1
)
node server.js
echo.
pause
