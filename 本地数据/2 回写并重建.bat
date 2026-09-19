@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo ================================================
echo  步骤 2/2  回写 CSV 到数据文件，并重建站点
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
echo --- 回写数据（旧 JSON 会自动备份）---
"%PY%" local_data.py import
if errorlevel 1 ( echo. & echo [失败] 回写未完成 & pause & exit /b 1 )
echo.
echo --- 重建站点 ---
"%PY%" local_data.py build
if errorlevel 1 ( echo. & echo [失败] 构建未通过 & pause & exit /b 1 )
echo.
echo 全部完成。刷新网站页面即可看到改动。
pause
