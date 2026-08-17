@echo off
title FigDrop [LOCAL EDITION] — Bridge
color 0B
echo ==========================================================
echo   ⚡ FigDrop [LOCAL EDITION] — 100%% Offline & Private
echo ==========================================================
echo.
echo  Starting local bridge server on http://localhost:8765 ...
echo  (Keep this window minimized while designing)
echo.

node "%~dp0bridge-server\dist\server.js"

pause
