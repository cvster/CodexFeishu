@echo off
setlocal

set "WORKSPACE=%~dp0"
set "BUNDLED_PYTHON=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
set "PYTHON_EXE="

if defined MOBILE_CODEX_PYTHON (
  if exist "%MOBILE_CODEX_PYTHON%" set "PYTHON_EXE=%MOBILE_CODEX_PYTHON%"
)

if exist "%BUNDLED_PYTHON%" (
  if not defined PYTHON_EXE set "PYTHON_EXE=%BUNDLED_PYTHON%"
)

if not defined PYTHON_EXE (
  where python.exe >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=python.exe"
)

if not defined PYTHON_EXE (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_EXE=python"
)

if not defined PYTHON_EXE (
  echo Python 3.11+ was not found.
  echo Install Python or set MOBILE_CODEX_PYTHON, then run this script again.
  pause
  exit /b 1
)

pushd "%WORKSPACE%" || exit /b 1

echo Starting mobileCodexHelper...
"%PYTHON_EXE%" "%WORKSPACE%mobile_codex_control.py" --action start --json
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo Start failed. See the error above.
  popd
  pause
  exit /b %EXIT_CODE%
)

echo Start completed.
echo Local app: http://127.0.0.1:3001
echo Local proxy: http://127.0.0.1:8080
echo Private network: http://192.168.188.2:8080
echo.
popd
pause
