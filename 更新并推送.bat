@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

rem ============================================================
rem  税码通  -  重新生成 + 提交 + 推送到 GitHub
rem  第一次运行会问：GitHub 用户名 / 邮箱 / Token
rem  Token 存进 Windows 凭据管理器，以后不用再输
rem ============================================================

set "REPO=shuimatong"
rem 让 python 的输出用控制台原生代码页，避免中文乱码
set "PYTHONIOENCODING=gbk"
rem 只禁掉 git 自己的控制台提问。
rem 【不要】加 GCM_INTERACTIVE=never —— 实测该模式会让 GCM 连本机已存好的
rem 凭据都不返回，直接报 could not read Username for 'https://github.com'，
rem 于是每次推送都被误判成"需要授权"。本机已存凭据时，这一行不加就能免密推送。
set "GIT_TERMINAL_PROMPT=0"

echo ============================================================
echo  税码通   重新生成 - 提交 - 推送
echo  目录: %CD%
echo  仓库: %REPO%
echo ============================================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [错误] 没找到 git，请先安装 Git for Windows
  echo        https://git-scm.com/download/win
  goto :hold
)

rem ---------- 0/5 提交身份 ----------
set "CURNAME="
for /f "delims=" %%u in ('git config --local user.name 2^>nul') do set "CURNAME=%%u"
if defined CURNAME goto :id_ok

echo [0/5] 首次设置提交身份（会写进提交记录，公开可见）
set "GHUSER="
set /p "GHUSER=  GitHub 用户名 : "
if not defined GHUSER (
  echo [错误] 用户名不能为空，已中止。
  goto :hold
)
set "GHEMAIL="
set /p "GHEMAIL=  邮箱（直接回车 = 用 GitHub 私有邮箱） : "
if not defined GHEMAIL set "GHEMAIL=!GHUSER!@users.noreply.github.com"
git config --local user.name "!GHUSER!"
git config --local user.email "!GHEMAIL!"
echo  提交身份已写入: !GHUSER! [!GHEMAIL!]
goto :regen

:id_ok
set "GHUSER=!CURNAME!"
echo [0/5] 提交身份: !GHUSER!

rem ---------- 1/5 重新生成 ----------
:regen
echo.
echo [1/5] 重新生成网站产物 ...
set "PY="
for /f "delims=" %%q in ('where python 2^>nul') do if not defined PY set "PY=%%q"
if not defined PY goto :regen_skip
"!PY!" "build\bundle.py"
if errorlevel 1 (
  echo.
  echo [错误] 生成失败，已中止，没有推送任何东西。
  goto :hold
)
echo  已重新生成 site\
goto :stage

:regen_skip
echo  [跳过] 本机没有 Python，沿用现有 site\ 产物
echo         要改数据请先装 Python: https://www.python.org/downloads/

rem ---------- 2/5 暂存 ----------
:stage
echo.
echo [2/5] 暂存改动 ...
rem 首次提交前把分支名统一成 main（GitHub Pages 惯例）
git rev-parse --verify HEAD >nul 2>nul
if errorlevel 1 git branch -M main
git add -A

rem ---------- 3/5 安全闸门 ----------
echo.
echo [3/5] 安全闸门：账号库 / 依赖 / 硬编码口令 ...
set "K1=admin"
set "K2=123"
set "S1=zg_test"
set "S2=_secret"
set "D1=dev-secret-change"
set "D2=-me-in-prod"

git diff --cached --name-only > "%TEMP%\_zg_staged.txt"
findstr /i /r "server/data/ \.db$ \.db-wal$ \.db-shm$ node_modules/ \.jwt_secret$" "%TEMP%\_zg_staged.txt" >nul 2>nul
if not errorlevel 1 goto :gate_bad
del "%TEMP%\_zg_staged.txt" >nul 2>nul

git grep --cached -n -I -e "%K1%%K2%" -e "%S1%%S2%" -e "%D1%%D2%" > "%TEMP%\_zg_leak.txt" 2>nul
if not errorlevel 1 goto :leak_bad
del "%TEMP%\_zg_leak.txt" >nul 2>nul
echo  通过：不含账号库 / 依赖 / 硬编码口令
goto :commit

:gate_bad
echo.
echo  [!!] 检测到不该上传的文件，已中止：
findstr /i /r "server/data/ \.db$ \.db-wal$ \.db-shm$ node_modules/ \.jwt_secret$" "%TEMP%\_zg_staged.txt"
del "%TEMP%\_zg_staged.txt" >nul 2>nul
echo  请检查 .gitignore 后重试。
goto :hold

:leak_bad
echo.
echo  [!!] 内容闸门命中硬编码口令 / 密钥，已中止：
type "%TEMP%\_zg_leak.txt"
del "%TEMP%\_zg_leak.txt" >nul 2>nul
echo  请先改成从环境变量读取，再重试。
goto :hold

rem ---------- 4/5 提交 ----------
:commit
echo.
echo [4/5] 提交 ...
git diff --cached --quiet
if errorlevel 1 goto :do_commit
echo  没有新改动，跳过提交
goto :push

:do_commit
git commit -q -m "更新网站内容 %DATE% %TIME%"
if errorlevel 1 (
  echo  [错误] 提交失败，多半是提交身份没配好。
  goto :hold
)
echo  已提交

rem ---------- 5/5 推送 ----------
:push
echo.
echo [5/5] 推送到 GitHub ...
set "URL="
for /f "delims=" %%r in ('git remote get-url origin 2^>nul') do set "URL=%%r"
if not defined URL goto :set_remote
echo  远程: !URL!
goto :do_push

:set_remote
git remote remove origin >nul 2>nul
git remote add origin "https://github.com/!GHUSER!/%REPO%.git"
echo  已设置远程: https://github.com/!GHUSER!/%REPO%.git

:do_push
set "BR="
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "BR=%%b"
if not defined BR set "BR=main"

rem 强制直连：本机的白名单代理会让 github 全部连不上
git -c http.proxy= -c https.proxy= push -u origin "!BR!"
if errorlevel 1 goto :auth
goto :done

rem ---------- 授权（仅在推送失败时进入）----------
:auth
echo.
echo  推送需要 GitHub 授权。
echo  Token 申请: https://github.com/settings/tokens/new  （勾选 repo 就够）
echo.
set "GHTOK="
set /p "GHTOK=  粘贴 Token (ghp_ 开头共 40 位): "
if not defined GHTOK (
  echo  已取消。
  goto :hold
)

set "CRDTMP=%TEMP%\_zg_cred.txt"
(
  echo protocol=https
  echo host=github.com
  echo username=!GHUSER!
  echo password=!GHTOK!
) > "!CRDTMP!"
git credential approve < "!CRDTMP!"
del "!CRDTMP!" >nul 2>nul
echo  已存入 Windows 凭据管理器，以后不用再输。

rem 仓库不存在就自动建一个公开仓库
> "%TEMP%\_zg_req.json" echo {"name":"%REPO%","private":false,"has_issues":false,"has_wiki":false}
curl -s -o "%TEMP%\_zg_api.txt" -w "%%{http_code}" -X POST ^
  -H "Authorization: Bearer !GHTOK!" ^
  -H "Content-Type: application/json" ^
  --data @"%TEMP%\_zg_req.json" ^
  https://api.github.com/user/repos > "%TEMP%\_zg_code.txt" 2>nul
set "CODE="
set /p CODE=<"%TEMP%\_zg_code.txt"
del "%TEMP%\_zg_req.json" "%TEMP%\_zg_api.txt" >nul 2>nul
if "!CODE!"=="201" echo  已自动创建公开仓库 !GHUSER!/%REPO%
if "!CODE!"=="422" echo  仓库已存在，跳过创建
if "!CODE!"=="404" echo  [提示] 自动建仓库没成功，请手动去 GitHub 新建一个叫 %REPO% 的仓库
if "!CODE!"=="" echo  [提示] 没能确认仓库状态，若推送失败请手动新建 %REPO%
del "%TEMP%\_zg_code.txt" >nul 2>nul

echo.
echo  再次推送 ...
git -c http.proxy= -c https.proxy= push -u origin "!BR!"
if errorlevel 1 (
  echo.
  echo [失败] 仍推不上去，逐条检查：
  echo   1. 仓库已在 GitHub 建好，名字必须是 %REPO%
  echo   2. Token 勾了 repo 权限、且没过期
  echo   3. 用户名与仓库名的大小写是否一致
  goto :hold
)

rem 首次推送成功，顺手开启 GitHub Pages
echo.
echo  正在开启 GitHub Pages ...
> "%TEMP%\_zg_pg.json" echo {"source":{"branch":"!BR!","path":"/"}}
curl -s -o "%TEMP%\_zg_pgr.txt" -w "%%{http_code}" -X POST ^
  -H "Authorization: Bearer !GHTOK!" ^
  -H "Content-Type: application/json" ^
  --data @"%TEMP%\_zg_pg.json" ^
  https://api.github.com/repos/!GHUSER!/%REPO%/pages > "%TEMP%\_zg_pgc.txt" 2>nul
set "PCODE="
set /p PCODE=<"%TEMP%\_zg_pgc.txt"
del "%TEMP%\_zg_pg.json" "%TEMP%\_zg_pgr.txt" "%TEMP%\_zg_pgc.txt" >nul 2>nul
if "!PCODE!"=="201" echo  Pages 已开启
if "!PCODE!"=="409" echo  Pages 之前就已开启
if "!PCODE!"=="404" echo  [提示] Pages 没开成，手动去 Settings - Pages 选 main / root

:done
echo.
echo ============================================================
echo  完成！改动已上线
echo  仓库: https://github.com/!GHUSER!/%REPO%
echo  网址: https://!GHUSER!.github.io/%REPO%/
echo ============================================================

:hold
echo.
pause
