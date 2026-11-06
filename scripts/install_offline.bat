@echo off
chcp 65001 >nul
REM 인터넷이 없는 관리자 PC 설치: 미리 받아 둔 wheels 폴더와 frontend\dist 를 사용
cd /d "%~dp0.."
python -m venv .venv
call .venv\Scripts\activate.bat
pip install --no-index --find-links wheels -r backend\requirements.txt
cd backend
python -m app.cli init-db
python -m app.cli seed-devices --count 20
echo 설치 완료. scripts\start_server.bat 로 실행하세요.
pause
