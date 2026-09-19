@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo ================================================
echo  体检：核对数据一致性与条数（只读，不改任何文件）
echo ================================================
set "PY="
for %%P in (
  "C:\Users\admin\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  "C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  "C:\Users\admin\AppData\Local\Programs\Python\Python312\python.exe"
) do if not defined PY if exist %%P set "PY=%%~P"
if not defined PY for /f "delims=" %%P in ('where python 2^>nul') do if not defined PY set "PY=%%P"
if not defined PY (
  echo [错误] 未找到 python，请手动在本目录执行： python local_data.py export
  pause
  exit /b 1
)
echo.
"%PY%" local_data.py check
echo.
pause
