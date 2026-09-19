@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=3001"
rem JWT_SECRET 不再硬编码：后端首次启动自动生成随机密钥，
rem 持久化到 server\data\.jwt_secret 并复用（该文件不纳入版本控制）
rem 如需指定，取消下一行注释并换成自己的强随机串
rem set "JWT_SECRET=换成你自己的强随机串"
set "URL=http://localhost:3001/"

echo ============================================================
echo   税码通 . 本地服务启动器
echo   站点目录: %~dp0
echo ============================================================
echo.

rem ================= 1/4 探测 Node =================
set "NODE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" set "NODE=%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not defined NODE if exist "C:\Program Files\nodejs\node.exe" set "NODE=C:\Program Files\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE set "NODE=%%I"

if not defined NODE (
  echo [错误] 没找到 node.exe
  echo        请安装 Node.js 22 或更高版本: https://nodejs.org/
  echo        已尝试位置:
  echo          %%USERPROFILE%%\.workbuddy\binaries\node\versions\
  echo          C:\Program Files\nodejs\node.exe
  echo          PATH 中的 node
  echo.
  pause
  exit /b 1
)
echo [1/4] Node    : %NODE%

rem ================= 2/4 检查后端文件与依赖 =================
if not exist "server\server.js" (
  echo [错误] 缺少 server\server.js
  echo        请确认本脚本放在站点根目录（与 server 文件夹同级）
  echo.
  pause
  exit /b 1
)

for %%D in ("%NODE%") do set "NODEDIR=%%~dpD"

if exist "server\node_modules\express" (
  echo [2/4] 依赖    : 已就绪
) else (
  echo [2/4] 依赖    : 首次运行，正在安装 ...
  if exist "%NODEDIR%npm.cmd" (
    pushd server
    call "%NODEDIR%npm.cmd" install --omit=dev
    popd
    if not exist "server\node_modules\express" (
      echo [错误] 依赖安装失败，请检查网络后重试
      echo.
      pause
      exit /b 1
    )
  ) else (
    echo [警告] 找不到 npm.cmd，无法自动安装依赖
    echo        请手动执行: cd server ^&^& npm install
    echo.
    pause
    exit /b 1
  )
)

rem ================= 3/4 端口检查 / 启动 =================
"%NODE%" -e "const n=require('net'),s=n.connect(%PORT%,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500);"
if not errorlevel 1 (
  echo [3/4] 端口    : %PORT% 已在运行，直接打开页面
  goto :open
)

echo [3/4] 端口    : 正在启动后端服务 ...
start "税码通后端" /min cmd /c ""%NODE%" --experimental-sqlite "server\server.js" >> "server\server.log" 2>&1"

rem 等待端口就绪（最多 25 秒）
"%NODE%" -e "const n=require('net'),t=Date.now();(function p(){const s=n.connect(%PORT%,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>{s.destroy();if(Date.now()-t>25000)process.exit(1);setTimeout(p,400)})})()"
if errorlevel 1 goto :startfail
echo        后端已就绪

:open
echo [4/4] 打开浏览器: %URL%
start "" "%URL%"
echo.
echo ============================================================
echo   已启动 : %URL%
echo   停止   : 关闭标题为「税码通后端」的窗口，或在任务管理器结束 node.exe
echo   离线可用: 即使后端未启动，用浏览器直接打开 site\index.html 也可查询
echo ============================================================
timeout /t 4 >nul
exit /b 0

:startfail
echo.
echo [错误] 后端 %PORT% 端口在 25 秒内未就绪
echo ---------- server\server.log 末尾 ----------
if exist "server\server.log" (
  "%NODE%" -e "try{const l=require('fs').readFileSync('server/server.log','utf8').trim().split(/\r?\n/);console.log(l.slice(-15).join('\n'))}catch(e){console.log('(读取日志失败)')}"
) else (
  echo   (没有生成 server\server.log)
)
echo ------------------------------------------------
echo   常见原因:
echo     1. 端口 %PORT% 被其它程序占用
echo     2. server\node_modules 依赖不完整
echo     3. server\data\zhiguantong.db 被占用或无权限
echo.
pause
exit /b 1
