# Kusto web sign-in harness

A tiny plain-JavaScript web extension used to check, in a real browser host, that VS Code's
built-in Microsoft auth provider can issue a Kusto token and that the token can run `print 1`
against a cluster over CORS. It is a development tool and is not part of the shipped extension.

The command **Kusto Web Harness: Sign in and run print 1**:

1. Prompts for a cluster URI and database.
2. Reads `/v1/rest/auth/metadata` and shows the cluster's `KustoServiceResourceId`, next to the
   scope the extension currently derives for that URI.
3. For each candidate scope (metadata audience, `https://kusto.kusto.windows.net/.default`, the
   per-host scope and the derived scope) calls
   `vscode.authentication.getSession('microsoft', [scope], { createIfNone: true })`, logs the
   non-secret token claims (`aud`, `tid`, `appid`, `scp`, `upn`, expiry), and posts
   `print one = 1` to `/v2/rest/query`.
4. Prints a PASS/FAIL line per scope. All output goes to the **Kusto Web Harness** output channel.

## Manual test on vscode.dev

vscode.dev can sideload an extension from an HTTPS URL that sends CORS headers.

1. Install mkcert once and trust its local CA:

   ```powershell
   winget install FiloSottile.mkcert
   mkcert -install
   ```

2. From this folder, create a certificate and serve the folder over HTTPS:

   ```powershell
   cd tools\web-signin-harness
   mkcert localhost
   npx serve --cors -l 5000 --ssl-cert localhost.pem --ssl-key localhost-key.pem
   ```

   The `serve.json` in this folder adds `Cross-Origin-Resource-Policy: cross-origin`, which
   vscode.dev needs to load the files. The generated `*.pem` files are git-ignored.

3. Open <https://localhost:5000/package.json> in the browser once to confirm the certificate is
   trusted.
4. Open <https://vscode.dev>, run **Developer: Install Extension From Location...**, and enter
   `https://localhost:5000`.
5. Run **Kusto Web Harness: Sign in and run print 1**. Accept the defaults for
   `help.kusto.windows.net`/`Samples`, and complete the Microsoft sign-in prompts.
6. Read the **Kusto Web Harness** output channel. If something fails, also check the browser
   DevTools console (F12) for CORS or auth-provider errors.

Repeat step 5 with a cluster you own, and with a Fabric Eventhouse query URI
(`https://<id>.<region>.kusto.fabric.microsoft.com`). For Fabric, compare the
`KustoServiceResourceId` line with the "scope the desktop extension would derive today" line;
if they differ, note which scope passed.

The same sideload works on github.dev. In a browser Codespace, the extension runs in the remote
(Node) host, so the browser-specific path is exercised only by vscode.dev and github.dev.

## Headless run with @vscode/test-web

`@vscode/test-web` does not register the `microsoft` auth provider (`getSession` times out), so the
headless run injects a token from the Azure CLI and checks only the query path:

```powershell
cd src\Client
$tmp = Join-Path $env:TEMP "kwh-$(Get-Random)"; New-Item -ItemType Directory $tmp | Out-Null
az account get-access-token --resource https://kusto.kusto.windows.net --query accessToken -o tsv |
  Set-Content -NoNewline "$tmp\token.txt"
$h = (Resolve-Path ..\..\tools\web-signin-harness).Path
node node_modules\@vscode\test-web\out\server\index.js --browserType=chromium --headless `
  --quality=stable --extensionDevelopmentPath=$h --extensionTestsPath="$h\test\headless.js" $tmp
Remove-Item -Recurse -Force $tmp
```

The test fails unless at least one scope runs `print 1` successfully.
