@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

if not exist "package.json" (
  echo error: package.json not found in "%SCRIPT_DIR%" 1>&2
  exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
  echo error: 'node' was not found on PATH. 1>&2
  echo Install Node.js 20 or newer ^(see README^) and try again. 1>&2
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo error: 'npm' was not found on PATH. 1>&2
  echo Install Node.js 20 or newer ^(see README^) and try again. 1>&2
  exit /b 1
)

set "CLEAN=0"
set "PACKAGE=0"

:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--clean" (
  set "CLEAN=1"
  shift
  goto parse
)
if /i "%~1"=="-clean" (
  set "CLEAN=1"
  shift
  goto parse
)
if /i "%~1"=="--package" (
  set "PACKAGE=1"
  shift
  goto parse
)
if /i "%~1"=="-package" (
  set "PACKAGE=1"
  shift
  goto parse
)
echo error: unknown option: %~1 1>&2
echo usage: build.bat [--clean] [--package] 1>&2
exit /b 2

:parsed
if "%CLEAN%"=="1" goto install
if not exist "node_modules" goto install
echo ==^> node_modules present; skipping npm install ^(use -Clean to force^)
goto build

:install
echo ==^> npm install
call npm install
if errorlevel 1 exit /b %errorlevel%

:build
echo ==^> npm run build
call npm run build
if errorlevel 1 exit /b %errorlevel%

if not "%PACKAGE%"=="1" goto done
echo ==^> npm run package
call npm run package
if errorlevel 1 exit /b %errorlevel%
for /f "delims=" %%f in ('dir /b /o-d *.vsix 2^>nul') do (
  echo ==^> created %%f
  goto done
)

:done
exit /b 0
