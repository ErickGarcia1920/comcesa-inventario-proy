# Mantiene corriendo el vigilante de existencias; si se cae, lo vuelve a iniciar a los 15 segundos.
Set-Location (Join-Path $PSScriptRoot '..')
while ($true) {
    & node scripts\watch-existencias.js
    if ($LASTEXITCODE -eq 2) { break }   # ya hay otro vigilante corriendo
    Start-Sleep -Seconds 15
}
