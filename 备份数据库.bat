@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
echo ============================================================
echo   数据库备份（VACUUM INTO 单文件快照）
echo   数据库是 WAL 模式，直接拷 zhiguantong.db 会丢 WAL 里未合并的写入
echo ============================================================
echo.
set "NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"
if not defined NODE (
  echo [错误] 没找到 node.exe，请先安装 Node.js 22+
  pause
  exit /b 1
)
if not exist "server\backup_db.js" (
  echo [错误] 缺少 server\backup_db.js
  pause
  exit /b 1
)
"%NODE%" --experimental-sqlite "server\backup_db.js"
echo.
pause
