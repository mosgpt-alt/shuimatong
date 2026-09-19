@echo off
setlocal
cd /d "%~dp0"
title 税码通 - 备用推送通道
echo ==================================================
echo   税码通 . 备用推送通道（走 api.github.com）
echo   github.com 连不上时用这个，效果与「更新并推送.bat」相同
echo ==================================================
echo.
echo 正在推送，请稍候（首次可能要几十秒）...
echo.
python "%~dp0tools\push_via_api.py" --align
if errorlevel 1 (
  echo.
  echo [!] 没推成功，把上面的提示发给助手看看
) else (
  echo.
  echo [OK] 推送完成，约 1 分钟后网站自动更新
)
echo.
pause
