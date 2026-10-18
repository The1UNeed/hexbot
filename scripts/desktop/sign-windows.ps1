param([Parameter(Mandatory = $true)][string[]]$Path)
$ErrorActionPreference = 'Stop'
if (-not $env:WIN_CSC_LINK -or -not $env:WIN_CSC_KEY_PASSWORD) {
  throw 'WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD are required to sign Windows releases.'
}
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  [Convert]::FromBase64String($env:WIN_CSC_LINK),
  $env:WIN_CSC_KEY_PASSWORD,
  [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
)
try {
  if (-not $certificate.HasPrivateKey) { throw 'The Windows signing certificate has no private key.' }
  foreach ($item in $Path) {
    $file = (Resolve-Path -LiteralPath $item).Path
    $signature = Set-AuthenticodeSignature -FilePath $file -Certificate $certificate -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
    if ($signature.Status -ne 'Valid') { throw "Signing failed for ${file}: $($signature.StatusMessage)" }
    $verified = Get-AuthenticodeSignature -LiteralPath $file
    if ($verified.Status -ne 'Valid' -or $verified.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
      throw "Windows signature verification failed for $file"
    }
    Write-Output "Verified Authenticode signature: $file"
  }
} finally {
  $certificate.Dispose()
}
