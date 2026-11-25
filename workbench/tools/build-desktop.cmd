@echo off
setlocal
if defined VCToolsInstallDir goto build
set "TW_VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%TW_VSWHERE%" exit /b 1
for /f "usebackq delims=" %%I in (`"%TW_VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "TW_VS=%%I"
if not defined TW_VS exit /b 1
call "%TW_VS%\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
:build
"%USERPROFILE%\.cargo\bin\cargo.exe" build --manifest-path src-tauri/Cargo.toml --target-dir native-build --features custom-protocol
if errorlevel 1 exit /b %errorlevel%
if /I "%~1"=="--compile-only" exit /b 0
node tools\install-desktop.mjs
exit /b %errorlevel%
