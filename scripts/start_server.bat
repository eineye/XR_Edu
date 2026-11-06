@echo off
chcp 65001 >nul
REM MR EDU MOBILE 2.0 관리자 서버 실행 (Windows)
cd /d "%~dp0..\backend"
if exist "..\.venv\Scripts\activate.bat" call "..\.venv\Scripts\activate.bat"
python -m app.cli init-db >nul
echo 관리자 화면: http://localhost:8000  (HMD 접속 주소는 [네트워크·시스템 설정] 화면 참고)
python -m app.main
pause
