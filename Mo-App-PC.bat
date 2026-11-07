@echo off
rem FocusChangeAI - PC leg, app-window mode. Starts the local static server, then opens Chrome with
rem --app so the page runs in its own window and taskbar icon instead of a normal browser tab.
rem Console text is ASCII on purpose: cmd.exe reads .bat in the OEM codepage, so Vietnamese diacritics
rem would print as mojibake. The web page itself carries the accented wording.
setlocal
cd /d "%~dp0"

set "PORT=8731"
set "ROOT=%~dp0dist"
set "URL=http://localhost:%PORT%/"
set "ONLINE=https://focuschangeai-pc-fibfycas7he.qoder.website"

set "CHROME="
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not defined CHROME if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not defined CHROME (
  echo KHONG TIM THAY Chrome tren may nay.
  echo Mo link da dang bang trinh duyet khac:
  echo   %ONLINE%
  pause
  exit /b 1
)

if /i "%~1"=="online" (
  echo Mo cua so app tu link da dang.
  start "" "%CHROME%" --app=%ONLINE% --window-size=1280,800
  exit /b 0
)

call :is_up
if %errorlevel%==0 goto :open

where python.exe >nul 2>nul
if %errorlevel%==0 (
  start "FocusChangeAI PC server - giu cua so nay mo" /min python -m http.server %PORT% --bind 127.0.0.1 --directory "%ROOT%"
  goto :wait
)
where py.exe >nul 2>nul
if %errorlevel%==0 (
  start "FocusChangeAI PC server - giu cua so nay mo" /min py -3 -m http.server %PORT% --bind 127.0.0.1 --directory "%ROOT%"
  goto :wait
)
start "FocusChangeAI PC server - giu cua so nay mo" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-pc.ps1" -Root "%ROOT%" -Port %PORT%

:wait
set /a TRY=0
:poll
call :is_up
if %errorlevel%==0 goto :open
set /a TRY+=1
if %TRY% GEQ 25 goto :timeout
ping -n 2 127.0.0.1 >nul
goto :poll

:open
echo Mo cua so app tai %URL%
start "" "%CHROME%" --app=%URL% --window-size=1280,800
echo Dong cua so app de thoat. Server van chay nen lan mo sau nhanh hon nhieu.
goto :done

:timeout
echo Server khong phan ong sau 25 giay.
echo Kiem tra index.html co that nam trong: %ROOT%
echo Hoac chay Chay-Webcam-PC.bat de xem loi cu the.
goto :done

:done
exit /b 0

:is_up
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:%PORT%/index.html') -TimeoutSec 2 > $null; exit 0}catch{exit 1}" 2>nul
exit /b %errorlevel%
