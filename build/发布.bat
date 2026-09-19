@echo off
chcp 65001 >nul 2>&1
rem 按脚本自身位置定位项目根目录（原为写死的 I:\智关通编码网站，已失效）
cd /d "%~dp0.."
echo 正在重新生成站点（离线版 + 线上版）...
set "PY="
for %%P in (
  "C:\Users\admin\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  "C:\Users\Administrator\.workbuddy\binaries\python\versions\3.13.12\python.exe"
  "C:\Users\admin\.workbuddy\binaries\python\versions\3.12.0\python.exe"
) do if not defined PY if exist %%P set "PY=%%~P"
if not defined PY for /f "delims=" %%P in ('where python 2^>nul') do if not defined PY set "PY=%%P"
if not defined PY (
  echo [错误] 未找到 python，请手动执行： python build\bundle.py
  pause
  exit /b 1
)
"%PY%" build\bundle.py
if errorlevel 1 (
  echo.
  echo [失败] 构建未通过，请查看上面的报错。
  pause
  exit /b 1
)
echo.
echo 完成！已生成：
echo   - 税码通.html         （离线双击版，单文件）
echo   - site\index.html     （线上版首页）
echo   - site\data.js        （线上版外置税则数据）
echo.
echo 如需把最新内容推到线上，请让 WorkBuddy 重新发布（对话里说"重新发布"即可）。
pause
