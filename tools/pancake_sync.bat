@echo off
rem รอบอัปเดตออเดอร์ Pancake -> database (เรียกจาก task "Hylme Pancake Sync" ทุก 30 นาที ผ่าน pancake_sync_hidden.vbs)
rem ผลแต่ละรอบ: private\pancake_sync.log
cd /d "%~dp0.."
node tools\pancake_sync.mjs >> private\pancake_sync_console.log 2>&1
