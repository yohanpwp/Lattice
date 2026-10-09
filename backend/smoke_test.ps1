$ErrorActionPreference = "Stop"

$tempDir = Join-Path $env:TEMP ("lattice_smoke_" + [Guid]::NewGuid().ToString().Substring(0, 8))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

try {
    $tenantJson = @"
{
  "version": 1,
  "tenant_id": "tenant_smoke",
  "backend_url": "http://127.0.0.1:8099",
  "realtime_url": "http://127.0.0.1:8099/api/realtime",
  "app_key": "pk_dev_smoke",
  "schema_version": "20260101_01",
  "min_client_version": "0.1.0",
  "features": ["payments"],
  "collections": []
}
"@
    Set-Content -Path (Join-Path $tempDir "tenant.json") -Value $tenantJson

    $featuresJson = @"
{
  "features": {
    "payments": {
      "enabled": true
    }
  }
}
"@
    Set-Content -Path (Join-Path $tempDir "features.json") -Value $featuresJson

    $env:TENANT_CONFIG = Join-Path $tempDir "tenant.json"
    $env:FEATURES_CONFIG = Join-Path $tempDir "features.json"

    Write-Host "Starting server on port 8099..."
    $proc = Start-Process -FilePath ".\server.exe" -ArgumentList "serve", "--http=127.0.0.1:8099", "--dir=$tempDir" -PassThru -NoNewWindow

    # Wait for server to be responsive
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/config" -Method Get -TimeoutSec 2
            if ($resp.tenant_id -eq "tenant_smoke") {
                $ready = $true
                break
            }
        } catch {}
    }

    if (-not $ready) {
        throw "Server failed to start within timeout"
    }
    Write-Host "[1/6] Config endpoint verified: $($resp.backend_url)"

    # Create test user
    $userBody = @{
        email = "smoke_user@example.com"
        password = "Password123456!"
        passwordConfirm = "Password123456!"
    } | ConvertTo-Json
    $user = Invoke-RestMethod -Uri "http://127.0.0.1:8099/api/collections/users/records" -Method Post -Body $userBody -ContentType "application/json"
    Write-Host "[2/6] Test user created: $($user.id)"

    # Authenticate test user
    $authBody = @{
        identity = "smoke_user@example.com"
        password = "Password123456!"
    } | ConvertTo-Json
    $auth = Invoke-RestMethod -Uri "http://127.0.0.1:8099/api/collections/users/auth-with-password" -Method Post -Body $authBody -ContentType "application/json"
    $token = $auth.token
    $authHeaders = @{ Authorization = $token }
    Write-Host "[3/6] User authenticated, token obtained"

    # Checkout
    $checkoutBody = @{
        order_id = "ord_smoke_99"
        amount = 5000
        currency = "THB"
        provider = "mock"
        idempotency_key = "idem_smoke_001"
    } | ConvertTo-Json
    $payment = Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/payments/checkout" -Method Post -Headers $authHeaders -Body $checkoutBody -ContentType "application/json"
    if ($payment.status -ne "pending" -or $payment.amount -ne 5000) {
        throw "Unexpected payment response: $($payment | ConvertTo-Json)"
    }
    $payId = $payment.id
    $chargeId = $payment.provider_charge_id
    Write-Host "[4/6] Checkout succeeded: id=$payId, provider_charge_id=$chargeId, status=$($payment.status)"

    # Idempotency replay check
    $replayed = Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/payments/checkout" -Method Post -Headers $authHeaders -Body $checkoutBody -ContentType "application/json"
    if ($replayed.id -ne $payId) {
        throw "Idempotency replay failed, got different id: $($replayed.id)"
    }

    # Idempotency conflict check
    $conflictBody = @{
        order_id = "ord_smoke_99"
        amount = 9999
        currency = "THB"
        provider = "mock"
        idempotency_key = "idem_smoke_001"
    } | ConvertTo-Json
    $gotConflict = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/payments/checkout" -Method Post -Headers $authHeaders -Body $conflictBody -ContentType "application/json"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 409) {
            $gotConflict = $true
        }
    }
    if (-not $gotConflict) {
        throw "Expected 409 Conflict for mismatched idempotency request"
    }
    # Cross-user replay check: create second user and attempt replay of user 1's key
    $user2Body = @{
        email = "smoke_user2@example.com"
        password = "Password123456!"
        passwordConfirm = "Password123456!"
    } | ConvertTo-Json
    $user2 = Invoke-RestMethod -Uri "http://127.0.0.1:8099/api/collections/users/records" -Method Post -Body $user2Body -ContentType "application/json"
    $auth2Body = @{
        identity = "smoke_user2@example.com"
        password = "Password123456!"
    } | ConvertTo-Json
    $auth2 = Invoke-RestMethod -Uri "http://127.0.0.1:8099/api/collections/users/auth-with-password" -Method Post -Body $auth2Body -ContentType "application/json"
    $auth2Headers = @{ Authorization = $auth2.token }

    $gotUser2Conflict = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/payments/checkout" -Method Post -Headers $auth2Headers -Body $checkoutBody -ContentType "application/json"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 409) {
            $gotUser2Conflict = $true
        }
    }
    if (-not $gotUser2Conflict) {
        throw "Expected 409 Conflict when user2 attempts to replay user1 idempotency key"
    }
    Write-Host "[5/7] Idempotency replay ownership isolation and conflict detection verified"

    # Webhook signature verification and state transition
    # Mock HMAC signature: HMAC-SHA256 of raw body with "mock_webhook_secret_key"
    $webhookPayload = '{"event":"charge.succeeded","provider_charge_id":"' + $chargeId + '","amount":5000,"currency":"THB"}'

    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = [System.Text.Encoding]::UTF8.GetBytes("mock_webhook_secret_key")
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($webhookPayload)
    $hashBytes = $hmac.ComputeHash($bodyBytes)
    $sigHex = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()

    $webhookHeaders = @{
        "X-Signature" = $sigHex
    }
    $hookResp = Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/webhooks/payments/mock" -Method Post -Headers $webhookHeaders -Body $webhookPayload -ContentType "application/json"
    if ($hookResp.status -ne "accepted") {
        throw "Webhook did not acknowledge with accepted: $($hookResp | ConvertTo-Json)"
    }

    # Fetch updated payment
    $updatedPayment = Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/payments/$payId" -Method Get -Headers $authHeaders
    if ($updatedPayment.status -ne "succeeded") {
        throw "GET /v1/payments/:id returned status $($updatedPayment.status), expected succeeded"
    }
    Write-Host "[6/7] Webhook HMAC verified and payment updated to succeeded!"

    # Verify delayed failed webhook is rejected and cannot overwrite succeeded payment
    $failedPayload = '{"event":"charge.failed","provider_charge_id":"' + $chargeId + '","amount":5000,"currency":"THB","status":"failed"}'
    $failedBodyBytes = [System.Text.Encoding]::UTF8.GetBytes($failedPayload)
    $failedSigHex = [System.BitConverter]::ToString($hmac.ComputeHash($failedBodyBytes)).Replace("-", "").ToLower()
    $failedHeaders = @{ "X-Signature" = $failedSigHex }
    $gotTransitionRejection = $false
    try {
        Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/webhooks/payments/mock" -Method Post -Headers $failedHeaders -Body $failedPayload -ContentType "application/json"
    } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 400) {
            $gotTransitionRejection = $true
        }
    }
    if (-not $gotTransitionRejection) {
        throw "Expected 400 Bad Request when delayed failed webhook attempts to overwrite succeeded payment"
    }
    $finalPayment = Invoke-RestMethod -Uri "http://127.0.0.1:8099/v1/payments/$payId" -Method Get -Headers $authHeaders
    if ($finalPayment.status -ne "succeeded") {
        throw "Payment status corrupted to $($finalPayment.status), expected succeeded"
    }
    Write-Host "[7/7] Delayed failed webhook transition properly rejected; state preserved!"
    Write-Host "`nPASS: Milestone M4 Live Smoke Probe Passed Successfully!"

} finally {
    if ($proc -and -not $proc.HasExited) {
        Write-Host "Stopping server process..."
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path $tempDir) {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
