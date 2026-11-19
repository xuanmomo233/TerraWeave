@echo off
call "D:\BuildTools\VS2022\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
"%USERPROFILE%\.cargo\bin\cargo.exe" test --manifest-path src-tauri/Cargo.toml --target-dir native-build --features custom-protocol
