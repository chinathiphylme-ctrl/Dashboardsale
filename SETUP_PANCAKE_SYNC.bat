@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Hylme - ตั้งค่าอัปเดตออเดอร์ Pancake อัตโนมัติ
echo ============================================================
echo  อัปเดตออเดอร์ Pancake เข้าแดชบอร์ดอัตโนมัติทุก 30 นาที
echo  1) รอบแรก: ดึง Pancake API แล้วบันทึกลง database (ผ่านตัวกันข้อมูลเสียก่อน)
echo  2) ตั้ง task "Hylme Pancake Sync" ให้รันเองทุก 30 นาที (ไม่มีหน้าต่างเด้ง)
echo  ต้องรัน "node tools\pancake_sync.mjs --setup" มาก่อนแล้ว
echo ============================================================
echo.
if not exist "private\sync_key.json" (
  echo [ERROR] ยังไม่ได้ตั้งกุญแจ — เปิด PowerShell แล้วรัน: node tools\pancake_sync.mjs --setup
  pause
  exit /b 2
)
echo [1/2] รอบแรก...
node tools\pancake_sync.mjs
if errorlevel 1 (
  echo.
  echo [หยุด] รอบแรกไม่ผ่าน — ไม่ได้ตั้ง task  ดูเหตุผลใน private\pancake_sync.log
  pause
  exit /b 1
)
echo.
echo [2/2] ตั้ง task ทุก 30 นาที...
schtasks /create /tn "Hylme Pancake Sync" /sc minute /mo 30 /tr "wscript.exe \"%~dp0tools\pancake_sync_hidden.vbs\"" /f
if errorlevel 1 (
  echo [ERROR] ตั้ง task ไม่สำเร็จ
  pause
  exit /b 1
)
echo.
echo [OK] เสร็จแล้ว — ดูผลแต่ละรอบได้ที่ private\pancake_sync.log
echo      หยุดอัตโนมัติ: schtasks /delete /tn "Hylme Pancake Sync" /f
pause
