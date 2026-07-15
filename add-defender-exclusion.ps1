# Defender exclusions for Amadeus (run as Administrator)
Add-MpPreference -ExclusionPath "E:\Amadeus" -ErrorAction SilentlyContinue
Add-MpPreference -ExclusionProcess "app.exe" -ErrorAction SilentlyContinue
Add-MpPreference -ExclusionProcess "node.exe" -ErrorAction SilentlyContinue
Add-MpPreference -ExclusionProcess "next-server.exe" -ErrorAction SilentlyContinue
Write-Host "=========================================="
Write-Host " OK: Defender exclusions added for Amadeus"
Write-Host "   Folder:  E:\Amadeus"
Write-Host "   Process: app.exe, node.exe, next-server.exe"
Write-Host "=========================================="
Start-Sleep -Seconds 3
