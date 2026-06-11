@echo off
title EDM Builder Server
echo ============================================
echo   EDM Builder — Company Server
echo ============================================
echo.
echo   Starting server on all network interfaces...
echo.

http-server "C:\Vs_Code_Project\edm-tool" -p 8090 -a 0.0.0.0 -c-1 --cors

echo.
echo   Server stopped. Close this window or press any key.
pause >nul
