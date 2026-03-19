#!/bin/bash
clear

echo ""
echo " ╔══════════════════════════════════════════╗"
echo " ║   Avance Dental — Gestor WhatsApp        ║"
echo " ╚══════════════════════════════════════════╝"
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
    echo " ❌ Node.js no está instalado."
    echo ""
    echo " Por favor instálalo desde: https://nodejs.org"
    echo " Descarga la versión LTS (botón verde grande)"
    echo " y vuelve a ejecutar este archivo."
    echo ""
    # Abrir web en Mac
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open https://nodejs.org
    fi
    exit 1
fi

NODE_VER=$(node --version)
echo " ✅ Node.js $NODE_VER detectado"
echo ""

# Instalar dependencias si no existen
if [ ! -d "node_modules" ]; then
    echo " 📦 Instalando dependencias (solo la primera vez, ~1 minuto)..."
    echo ""
    npm install
    if [ $? -ne 0 ]; then
        echo ""
        echo " ❌ Error al instalar. Comprueba tu conexión a internet."
        exit 1
    fi
    echo ""
    echo " ✅ Dependencias instaladas correctamente"
    echo ""
fi

# Abrir la app en el navegador (esperar 3s a que arranque el servidor)
(sleep 3 && {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        open "index.html"
    else
        xdg-open "index.html" 2>/dev/null || echo " Abre index.html manualmente en tu navegador"
    fi
}) &

echo " ════════════════════════════════════════════"
echo " ✅ Servidor iniciado en http://localhost:3001"
echo " ════════════════════════════════════════════"
echo ""
echo " 📱 PRÓXIMO PASO: Ve a la pestaña 'Programar envíos'"
echo "    y escanea el QR con WhatsApp"
echo ""
echo " ⚠️  NO cierres esta ventana mientras uses la app"
echo ""

# Iniciar servidor
node server.js
