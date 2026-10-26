import { URL } from "url";
import http from "http";
import { OAuth } from "@raycast/api";
import { callLoginWthOidc, callOidcAuthUrl, callRenewSelf } from "./utils";
import { getActiveVault, VaultInstance } from "./vaults";

const localPort = 8250;

// Renew tokens with less than this left, so a vault used at least once a token TTL stays signed in
const renewWithinMs = 30 * 60 * 1000;

const clients = new Map<string, OAuth.PKCEClient>();

// One client per vault so each instance keeps its own OIDC tokens
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

function rewriteQueryParam(url: string, paramName: string, paramValue: string): string {
  const urlObj = new URL(url);
  urlObj.searchParams.set(paramName, paramValue);
  return urlObj.toString();
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
  const authRequest = await client.authorizationRequest({
    endpoint: `http://localhost:${localPort}/authorize`,
    clientId: "vault",
    scope: "openid",
  });

  let accessToken = "";
  let expiresIn = 3600;
  const server = http.createServer(async function (req, res) {
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

      accessToken = vaultLoginResponse.auth.client_token;
      expiresIn = vaultLoginResponse.auth.lease_duration;
      res.writeHead(301, {
        Location: rewriteQueryParam(`${authRequest.redirectURI}&${queryPart}`, "state", authRequest.state),
      });
    } catch (error) {
      console.error("OIDC callback failed", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.write(`Vault login failed: ${error}`);
    }
    res.end();
  });

  await listen(server, localPort);
  try {
    await client.authorize({ url: vaultAuthUrlResponse.data.auth_url });
  } finally {
    server.close();
  }
  if (!accessToken) {
    throw new Error("Vault OIDC login did not return a token");
  }

  await client.setTokens({
    accessToken,
    expiresIn,
  });
  return accessToken;
}
