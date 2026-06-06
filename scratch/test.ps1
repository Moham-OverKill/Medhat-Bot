$headers = @{
    "Authorization" = "whs_93aca7e0c8b1658bf041d7e449df28f8f678b1a1d00bbc160a50a84959e9a831"
    "Content-Type" = "application/json"
}
$body = @{
    "type" = "test"
    "user" = "12345"
} | ConvertTo-Json
try {
    $response = Invoke-WebRequest -Uri "https://medhat-bot-production.up.railway.app/dblwebhook" -Method Post -Headers $headers -Body $body -ErrorAction Stop
    Write-Host "STATUS: $($response.StatusCode)"
    Write-Host "BODY: $($response.Content)"
} catch {
    Write-Host "ERROR: $_"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $responseBody = $reader.ReadToEnd()
        Write-Host "STATUS: $($_.Exception.Response.StatusCode)"
        Write-Host "BODY: $responseBody"
    }
}
