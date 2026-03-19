@echo off
chcp 65001 >nul
title Avance Dental — Instalación y arranque

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Avance Dental — Gestor WhatsApp        ║
echo  ╚══════════════════════════════════════════╝
echo.

:: Verificar Node.js
node --version >nul 2>&1
if errorlevel 1 (
    echo  ❌ Node.js no está instalado.
    echo.
    echo  Por favor instálalo desde: https://nodejs.org
    echo  Descarga la versión LTS ^(botón verde grande^)
    echo  y vuelve a ejecutar este archivo.
    echo.
    pause
    start https://nodejs.org
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo  ✅ Node.js %NODE_VER% detectado
echo.

:: Instalar dependencias si no existen
if not exist "node_modules" (
    echo  📦 Instalando dependencias ^(solo la primera vez, ~1 minuto^)...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo  ❌ Error al instalar. Comprueba tu conexión a internet.
        pause
        exit /b 1
    )
    echo.
    echo  ✅ Dependencias instaladas correctamente
    echo.
)

:: Abrir el navegador con la app
echo  🌐 Abriendo la aplicación en el navegador...
timeout /t 3 /nobreak >nul
start "" "index.html"

echo.
echo  ════════════════════════════════════════════
echo  ✅ Servidor iniciado en http://localhost:3001
echo  ════════════════════════════════════════════
echo.
echo  📱 PRÓXIMO PASO: Ve a la pestaña "Programar envíos"
echo     y escanea el QR con WhatsApp
echo.
echo  ⚠️  NO cierres esta ventana mientras uses la app
echo.

:: Iniciar servidor
node server.js

pause
