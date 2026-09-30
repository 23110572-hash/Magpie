@echo off
title Magpie Launcher
cls
echo =====================================================================
echo           MAGPIE - YOU ASK, IT COLLECTS
echo =====================================================================
echo.

echo [1/4] Checking backend dependencies...
python -c "import fastapi, uvicorn, sqlalchemy, httpx, bs4, psycopg2, dotenv, argon2, jwt" 2>nul
if errorlevel 1 (
    echo       Installing Python packages from backend\requirements.txt ...
    python -m pip install -r "%~dp0backend\requirements.txt"
)

echo [2/4] Checking frontend dependencies...
if not exist "%~dp0frontend\node_modules" (
    echo       Running npm install ...
    pushd "%~dp0frontend" && call npm install && popd
)

echo [3/4] Starting the API on http://localhost:8008 ...
start "Magpie Backend (port 8008)" cmd /k "cd /d %~dp0backend && python run.py"

echo [4/4] Starting the web app on http://localhost:5173 ...
start "Magpie Frontend (port 5173)" cmd /k "cd /d %~dp0frontend && npm run dev"

timeout /t 5 /nobreak >nul
start http://localhost:5173

echo.
echo   Web app:  http://localhost:5173
echo   API:      http://localhost:8008   (docs: /docs)
echo.
echo Press any key to close this window (the services keep running).
pause >nul
