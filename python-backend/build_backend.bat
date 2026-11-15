@echo off
cd /d "%~dp0"
if not defined PDF_BUILD_PYTHON set "PDF_BUILD_PYTHON=python"
echo Building the current backend with pinned dependencies...
"%PDF_BUILD_PYTHON%" build_backend.py
if errorlevel 1 exit /b %errorlevel%
echo Done. Output: dist\python_backend.exe
