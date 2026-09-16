@echo off
title Sean Deardorff Group Benefit Advisory - EOD Synchronization
color 0A

cd /d "%~dp0\.."

echo ===============================================================
echo [System] Sean Deardorff Group Benefit Advisory LLC
echo [System] Springfield MO Canvass & EOD Google Workspace Sync
echo ===============================================================
echo.

py scripts\google_workspace_sync.py

echo.
echo ===============================================================
echo [System] Sync process completed. Check logs and backups above.
echo ===============================================================
pause
