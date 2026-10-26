import http from "http";
import { OAuth, open, showToast, Toast } from "@raycast/api";
import { callLoginWthOidc, callOidcAuthUrl, callRenewSelf } from "./utils";
import { getActiveVault, VaultInstance } from "./vaults";

const localPort = 8250;

// Renew tokens with less than this left, so a vault used at least once a token TTL stays signed in
const renewWithinMs = 30 * 60 * 1000;

// Give up on a browser sign-in nobody finishes, so the callback port is freed
const signInTimeoutMs = 3 * 60 * 1000;

const clients = new Map<string, OAuth.PKCEClient>();

// One client per vault so each instance keeps its own OIDC tokens. Only its token storage is used: signing in
// goes straight to the browser rather than through Raycast's sign-in screen
function getClient(vault: VaultInstance = getActiveVault()): OAuth.PKCEClient {
  let client = clients.get(vault.id);
  if (!client) {
    client = new OAuth.PKCEClient({
      redirectMethod: OAuth.RedirectMethod.Web,
      providerName: `Vault (${vault.name})`,
      providerIcon: "vault.png",
      providerId: `vault-${vault.id}`,
      description: `Connect to ${vault.name} with OIDC provider (you can change the login method in the vault settings)`,
    });
    clients.set(vault.id, client);
  }
  return client;
}

function getQueryPart(url: string): string {
  return url.substring(url.indexOf("?") + 1);
}

function getQueryParam(url: string, paramName: string): string {
  const paramValue = new URLSearchParams(url).get(paramName);
  if (!paramValue) {
    throw new Error(`Could not find query param named ${paramName}`);
  }
  return paramValue;
}

export async function clearTokens(vault?: VaultInstance): Promise<void> {
  await getClient(vault).removeTokens();
}

const pendingAuthorizations = new Map<string, Promise<string>>();

// Screens can ask for a token at the same time; share one login per vault so only one callback server binds the port
export function authorize(): Promise<string> {
  const vault = getActiveVault();
  let pending = pendingAuthorizations.get(vault.id);
  if (!pending) {
    pending = login(vault).finally(() => pendingAuthorizations.delete(vault.id));
    pendingAuthorizations.set(vault.id, pending);
  }
  return pending;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE"
          ? new Error(`Port ${port} is already in use, so the OIDC login callback can't be received`)
          : error
      )
    );
    server.listen(port, resolve);
  });
}

async function login(vault: VaultInstance): Promise<string> {
  const client = getClient(vault);
  const tokenSet = await client.getTokens();
  if (tokenSet?.accessToken && !tokenSet.isExpired()) {
    const expiresAt = tokenSet.updatedAt.getTime() + (tokenSet.expiresIn ?? 0) * 1000;
    if (!tokenSet.expiresIn || expiresAt - Date.now() > renewWithinMs) {
      return tokenSet.accessToken;
    }
    try {
      const renewed = await callRenewSelf(tokenSet.accessToken);
      await client.setTokens({ accessToken: tokenSet.accessToken, expiresIn: renewed.auth.lease_duration });
    } catch (error) {
      // Still valid for now, so carry on and sign in again once it expires
      console.warn("Could not renew Vault token", error);
    }
    return tokenSet.accessToken;
  }

  const vaultAuthUrlResponse = await callOidcAuthUrl(`http://localhost:${localPort}/oidc/callback`);

  let server: http.Server | undefined;
  let timeout: NodeJS.Timeout | undefined;
  const signedIn = new Promise<{ accessToken: string; expiresIn: number }>((resolve, reject) => {
    server = http.createServer(async function (req, res) {
      if (!req.url?.startsWith("/oidc/callback")) {
        res.writeHead(404);
        res.end();
        return;
      }

      try {
        const queryPart = getQueryPart(req.url);
        const vaultLoginResponse = await callLoginWthOidc(
          getQueryParam(queryPart, "code"),
          getQueryParam(queryPart, "state")
        );
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(signInPage(`Signed in to ${vault.name}`, "You can close this tab and go back to Raycast."));
        resolve({
          accessToken: vaultLoginResponse.auth.client_token,
          expiresIn: vaultLoginResponse.auth.lease_duration,
        });
      } catch (error) {
        console.error("OIDC callback failed", error);
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(signInPage(`Could not sign in to ${vault.name}`, String(error)));
        reject(error);
      }
    });
    timeout = setTimeout(() => reject(new Error(`Timed out waiting to sign in to ${vault.name}`)), signInTimeoutMs);
  });

  await listen(server as http.Server, localPort);
  try {
    await showToast({ style: Toast.Style.Animated, title: `Signing in to ${vault.name} in your browser…` });
    await open(vaultAuthUrlResponse.data.auth_url);
    const tokens = await signedIn;
    await client.setTokens(tokens);
    await showToast({ style: Toast.Style.Success, title: `Signed in to ${vault.name}` });
    return tokens.accessToken;
  } finally {
    clearTimeout(timeout);
    server?.close();
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function signInPage(title: string, message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<body style="font-family: -apple-system, sans-serif; display: grid; place-items: center; height: 90vh; color: #333">
<div style="text-align: center"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body>`;
}
