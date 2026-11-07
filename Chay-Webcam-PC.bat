@echo off
rem FocusChangeAI - PC leg, offline mode. Serves the dist folder over http://localhost so the
rem browser treats it as a secure context (file:// refuses ES modules and getUserMedia).
rem Console text is ASCII on purpose: cmd.exe reads .bat in the OEM codepage, so Vietnamese
rem diacritics would print as mojibake. The web page itself carries the accented wording.
setlocal
cd /d "%~dp0"

set "PORT=8731"
set "ROOT=%~dp0dist"
set "URL=http://localhost:%PORT%/"

echo ==============================================================
echo  FocusChangeAI - ung dung PC, chay khong can wifi
echo  Thu muc app : %ROOT%
echo  Dia chi web : %URL%
echo  Dong cua so nay de dung server.
echo ==============================================================
echo.

call :is_up
if %errorlevel%==0 (
 echo Da co server o cong %PORT%, khong khoi dong lenh thu hai.
  goto :open
)

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
if exist "%~dp0serve-pc.ps1" (
  start "FocusChangeAI PC server - giu cua so nay mo" /min powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve-pc.ps1" -Root "%ROOT%" -Port %PORT%
  goto :wait
)

echo KHONG TIM THAY Python tren may nay va cung khong co serve-pc.ps1.
echo Cai Python 3 tu python.org roi chay lai file nay, hoac dung link da dang.
pause
exit /b 1

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
echo Server da san sang. Mo trinh duyet tai %URL%
start "" "%URL%"
goto :done

:timeout
echo Server khong phan ong sau 25 giay.
echo Kiem tra file index.html co that su nam trong: %ROOT%
goto :done

:done
echo.
echo (Neu mo sai trang, hay them /index.html vao dia chi roi Enter.)
pause
exit /b 0

:is_up
powershell -NoProfile -Command "try{Invoke-WebRequest -UseBasicParsing -Uri ('http://127.0.0.1:%PORT%/index.html') -TimeoutSec 2 > $null; exit 0}catch{exit 1}" 2>nul
exit /b %errorlevel%
