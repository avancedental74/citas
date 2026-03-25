#!/bin/bash
clear

echo ""
echo " ╔══════════════════════════════════════════╗"
echo " ║   Avance Dental — Gestor WhatsApp        ║"
echo " ╚══════════════════════════════════════════╝"
echo ""

# ── CONFIGURACIÓN ─────────────────────────────────────────────────────────────
REPO_ZIP="https://github.com/avancedental74/citas/archive/refs/heads/main.zip"
INSTALL_DIR="$HOME/avancedental-whatsapp"
PLIST="$HOME/Library/LaunchAgents/com.avancedental.whatsapp.plist"
PLIST_UPDATE="$HOME/Library/LaunchAgents/com.avancedental.update.plist"
UPDATE_SCRIPT="$INSTALL_DIR/auto_update.sh"

# ── NODE.JS ───────────────────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
    echo " ❌ Node.js no está instalado."
    echo " Instálalo desde: https://nodejs.org (botón verde LTS)"
    open https://nodejs.org
    exit 1
fi
echo " ✅ Node.js $(node --version) detectado"
echo ""

# ── FUNCIÓN: descargar y aplicar repo ────────────────────────────────────────
descargar_repo() {
    local TMP_ZIP="/tmp/avancedental_repo.zip"
    local TMP_DIR="/tmp/avancedental_extract"

    curl -fsSL "$REPO_ZIP" -o "$TMP_ZIP" || return 1
    rm -rf "$TMP_DIR"
    unzip -q "$TMP_ZIP" -d "$TMP_DIR" || return 1
    rm -f "$TMP_ZIP"

    local EXTRACTED=$(ls "$TMP_DIR" | head -1)
    mkdir -p "$INSTALL_DIR"

    [ -d "$INSTALL_DIR/auth_avancedental" ] && cp -r "$INSTALL_DIR/auth_avancedental" "/tmp/auth_backup"
    [ -f "$INSTALL_DIR/data.json" ]         && cp "$INSTALL_DIR/data.json"            "/tmp/data_backup.json"
    [ -f "$INSTALL_DIR/cola.json" ]         && cp "$INSTALL_DIR/cola.json"            "/tmp/cola_backup.json"
    [ -f "$INSTALL_DIR/config.json" ]       && cp "$INSTALL_DIR/config.json"          "/tmp/config_backup.json"
    [ -f "$INSTALL_DIR/leads.json" ]          && cp "$INSTALL_DIR/leads.json"           "/tmp/leads_backup.json"
    [ -f "$INSTALL_DIR/esperando.json" ]      && cp "$INSTALL_DIR/esperando.json"       "/tmp/esperando_backup.json"
    [ -f "$INSTALL_DIR/conversaciones.json" ] && cp "$INSTALL_DIR/conversaciones.json"  "/tmp/conversaciones_backup.json"
    [ -f "$INSTALL_DIR/yaenviados.json" ]    && cp "$INSTALL_DIR/yaenviados.json"      "/tmp/yaenviados_backup.json"
    [ -d "$INSTALL_DIR/backups" ]             && cp -r "$INSTALL_DIR/backups"           "/tmp/backups_backup"

    cp -r "$TMP_DIR/$EXTRACTED/." "$INSTALL_DIR/"
    rm -rf "$TMP_DIR"

    [ -d "/tmp/auth_backup" ]                  && cp -r "/tmp/auth_backup" "$INSTALL_DIR/auth_avancedental"
    [ -f "/tmp/data_backup.json" ]             && cp "/tmp/data_backup.json" "$INSTALL_DIR/data.json"
    [ -f "/tmp/cola_backup.json" ]             && cp "/tmp/cola_backup.json" "$INSTALL_DIR/cola.json"
    [ -f "/tmp/config_backup.json" ]           && cp "/tmp/config_backup.json" "$INSTALL_DIR/config.json"
    [ -f "/tmp/leads_backup.json" ]            && cp "/tmp/leads_backup.json" "$INSTALL_DIR/leads.json"
    [ -f "/tmp/esperando_backup.json" ]        && cp "/tmp/esperando_backup.json" "$INSTALL_DIR/esperando.json"
    [ -f "/tmp/conversaciones_backup.json" ]   && cp "/tmp/conversaciones_backup.json" "$INSTALL_DIR/conversaciones.json"
    [ -f "/tmp/yaenviados_backup.json" ]       && cp "/tmp/yaenviados_backup.json" "$INSTALL_DIR/yaenviados.json"
    [ -d "/tmp/backups_backup" ]               && cp -r "/tmp/backups_backup/." "$INSTALL_DIR/backups/"
    rm -rf /tmp/auth_backup /tmp/data_backup.json /tmp/cola_backup.json /tmp/config_backup.json /tmp/leads_backup.json /tmp/esperando_backup.json /tmp/conversaciones_backup.json /tmp/yaenviados_backup.json /tmp/backups_backup
}

# ── DESCARGAR REPO ────────────────────────────────────────────────────────────
echo " 📥 Descargando la última versión desde GitHub..."
descargar_repo
if [ $? -ne 0 ]; then
    echo " ❌ Error al descargar. Comprueba tu conexión."
    exit 1
fi
echo " ✅ Archivos actualizados"
echo ""

# ── DEPENDENCIAS ──────────────────────────────────────────────────────────────
cd "$INSTALL_DIR"
if [ ! -d "node_modules" ]; then
    echo " 📦 Instalando dependencias (solo la primera vez, ~1 minuto)..."
    npm install
    if [ $? -ne 0 ]; then
        echo " ❌ Error al instalar dependencias."
        exit 1
    fi
    echo " ✅ Dependencias instaladas"
    echo ""
fi

# ── CREAR SCRIPT DE ACTUALIZACIÓN DIARIA ─────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cat > "$UPDATE_SCRIPT" << 'UPDATEEOF'
#!/bin/bash
REPO_ZIP="https://github.com/avancedental74/citas/archive/refs/heads/main.zip"
INSTALL_DIR="$HOME/avancedental-whatsapp"
PLIST="$HOME/Library/LaunchAgents/com.avancedental.whatsapp.plist"
LOG="$INSTALL_DIR/update.log"

echo "[$(date '+%Y-%m-%d %H:%M')] Buscando actualizaciones..." >> "$LOG"

TMP_ZIP="/tmp/avancedental_update.zip"
TMP_DIR="/tmp/avancedental_update_extract"

curl -fsSL "$REPO_ZIP" -o "$TMP_ZIP" 2>>"$LOG" || {
    echo "[$(date '+%Y-%m-%d %H:%M')] Error al descargar" >> "$LOG"
    exit 1
}

rm -rf "$TMP_DIR"
unzip -q "$TMP_ZIP" -d "$TMP_DIR" || exit 1
rm -f "$TMP_ZIP"

EXTRACTED=$(ls "$TMP_DIR" | head -1)

# Comparar todos los archivos del repo (excepto datos, sesión y backups)
CHECKSUM_NUEVO=$(find "$TMP_DIR/$EXTRACTED" -type f \
    ! -path "*/auth_avancedental/*" ! -path "*/backups/*" \
    ! -name "data.json" ! -name "cola.json" ! -name "config.json" ! -name "*.log" \
    | sort | xargs md5 -q 2>/dev/null | md5 -q)

CHECKSUM_ACTUAL=$(find "$INSTALL_DIR" -type f \
    ! -path "*/auth_avancedental/*" ! -path "*/node_modules/*" ! -path "*/backups/*" \
    ! -name "data.json" ! -name "cola.json" ! -name "config.json" ! -name "*.log" \
    | sort | xargs md5 -q 2>/dev/null | md5 -q)

if [ "$CHECKSUM_NUEVO" = "$CHECKSUM_ACTUAL" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M')] Sin cambios — todo intacto" >> "$LOG"
    rm -rf "$TMP_DIR"
    exit 0
fi

echo "[$(date '+%Y-%m-%d %H:%M')] Cambios detectados — actualizando..." >> "$LOG"

[ -d "$INSTALL_DIR/auth_avancedental" ]      && cp -r "$INSTALL_DIR/auth_avancedental" "/tmp/auth_backup"
[ -f "$INSTALL_DIR/data.json" ]              && cp "$INSTALL_DIR/data.json"            "/tmp/data_backup.json"
[ -f "$INSTALL_DIR/cola.json" ]              && cp "$INSTALL_DIR/cola.json"            "/tmp/cola_backup.json"
[ -f "$INSTALL_DIR/config.json" ]            && cp "$INSTALL_DIR/config.json"          "/tmp/config_backup.json"
[ -f "$INSTALL_DIR/leads.json" ]             && cp "$INSTALL_DIR/leads.json"           "/tmp/leads_backup.json"
[ -f "$INSTALL_DIR/esperando.json" ]         && cp "$INSTALL_DIR/esperando.json"       "/tmp/esperando_backup.json"
[ -f "$INSTALL_DIR/conversaciones.json" ]    && cp "$INSTALL_DIR/conversaciones.json"  "/tmp/conversaciones_backup.json"
[ -f "$INSTALL_DIR/yaenviados.json" ]        && cp "$INSTALL_DIR/yaenviados.json"      "/tmp/yaenviados_backup.json"
[ -d "$INSTALL_DIR/backups" ]                && cp -r "$INSTALL_DIR/backups"           "/tmp/backups_backup"

cp -r "$TMP_DIR/$EXTRACTED/." "$INSTALL_DIR/"
rm -rf "$TMP_DIR"

[ -d "/tmp/auth_backup" ]                 && cp -r "/tmp/auth_backup" "$INSTALL_DIR/auth_avancedental"
[ -f "/tmp/data_backup.json" ]            && cp "/tmp/data_backup.json" "$INSTALL_DIR/data.json"
[ -f "/tmp/cola_backup.json" ]            && cp "/tmp/cola_backup.json" "$INSTALL_DIR/cola.json"
[ -f "/tmp/config_backup.json" ]          && cp "/tmp/config_backup.json" "$INSTALL_DIR/config.json"
[ -f "/tmp/leads_backup.json" ]           && cp "/tmp/leads_backup.json" "$INSTALL_DIR/leads.json"
[ -f "/tmp/esperando_backup.json" ]       && cp "/tmp/esperando_backup.json" "$INSTALL_DIR/esperando.json"
[ -f "/tmp/conversaciones_backup.json" ]  && cp "/tmp/conversaciones_backup.json" "$INSTALL_DIR/conversaciones.json"
[ -f "/tmp/yaenviados_backup.json" ]       && cp "/tmp/yaenviados_backup.json" "$INSTALL_DIR/yaenviados.json"
[ -d "/tmp/backups_backup" ]              && cp -r "/tmp/backups_backup/." "$INSTALL_DIR/backups/"
rm -rf /tmp/auth_backup /tmp/data_backup.json /tmp/cola_backup.json /tmp/config_backup.json /tmp/leads_backup.json /tmp/esperando_backup.json /tmp/conversaciones_backup.json /tmp/yaenviados_backup.json /tmp/backups_backup

launchctl unload "$PLIST" 2>/dev/null
sleep 2
launchctl load "$PLIST"

echo "[$(date '+%Y-%m-%d %H:%M')] Actualización aplicada y servidor reiniciado" >> "$LOG"
UPDATEEOF

chmod +x "$UPDATE_SCRIPT"

# ── LAUNCH AGENT: SERVIDOR ────────────────────────────────────────────────────
if [ ! -f "$PLIST" ]; then
    echo " ⚙️  Instalando autoarranque del servidor..."
    cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.avancedental.whatsapp</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>-c</string>
        <string>cd $INSTALL_DIR && node server.js</string>
    </array>
    <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$INSTALL_DIR/server_out.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/server_err.log</string>
    <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
EOF
    launchctl load "$PLIST"
    echo " ✅ Servidor: arranca solo al encender el Mac"
fi

# ── LAUNCH AGENT: ACTUALIZACIÓN DIARIA A LAS 11:00 ───────────────────────────
if [ ! -f "$PLIST_UPDATE" ]; then
    echo " ⚙️  Instalando actualización automática diaria a las 11:00..."
    cat > "$PLIST_UPDATE" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.avancedental.update</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$UPDATE_SCRIPT</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>11</integer>
        <key>Minute</key><integer>0</integer>
    </dict>
    <key>StandardOutPath</key><string>$INSTALL_DIR/update.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/update.log</string>
</dict>
</plist>
EOF
    launchctl load "$PLIST_UPDATE"
    echo " ✅ Actualizaciones: cada día a las 11:00"
fi

echo ""

# ── ARRANCAR SERVIDOR SI NO ESTÁ CORRIENDO ────────────────────────────────────
if curl -s --max-time 2 http://localhost:3001/api/status > /dev/null 2>&1; then
    echo " ✅ Servidor ya en marcha"
else
    echo " 🚀 Arrancando servidor..."
    launchctl unload "$PLIST" 2>/dev/null
    launchctl load "$PLIST"
    sleep 4
fi

# ── ABRIR WEB ─────────────────────────────────────────────────────────────────
open "http://localhost:3001"

echo ""
echo " ════════════════════════════════════════════"
echo " ✅ Todo listo en http://localhost:3001"
echo " ════════════════════════════════════════════"
echo ""
echo " • Servidor:       arranca solo al encender el Mac"
echo " • Actualizaciones: cada día a las 11:00"
echo " • Backups auto:   cada hora → $INSTALL_DIR/backups/"
echo " • Log:            $INSTALL_DIR/update.log"
echo ""
