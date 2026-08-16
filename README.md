# June Project

This repository was initialized by the assistant.

Minimal files and initial commit.



restart the server every, damn time please

$p = (Get-NetTCPConnection -LocalPort 3010 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 }); if ($p) { $p | ForEach-Object { taskkill /PID $_ /F } }; Start-Sleep -Seconds 1; npm start