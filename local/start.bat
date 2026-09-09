@echo off
rem Запуск хабу одним кліком: перший раз ставить залежності, далі просто стартує.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Створюю віртуальне середовище...
  py -3 -m venv .venv || goto :fail
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Створив .env — впиши TELEGRAM_TOKEN, якщо потрібен бот.
)

".venv\Scripts\python.exe" -m hub --open
goto :eof

:fail
echo.
echo Щось пішло не так під час встановлення.
pause
