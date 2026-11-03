@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0leneda_abruf.ps1"
if errorlevel 1 pause
