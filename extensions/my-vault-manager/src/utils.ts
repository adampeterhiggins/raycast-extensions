import NodeVault from "node-vault";
import {
  DeleteMode,
  ExportMode,
  VAULT_NAMESPACE_CACHE_KEY,
  VAULT_SECRET_ENGINE_CACHE_KEY,
  VAULT_TOKEN_CACHE_KEY,
  VaultAuthUrlResponse,
  VaultEntity,
  VaultListEntry,
  VaultLoginResponse,
  VaultMetaDataResponse,
  VaultMount,
  VaultReadMetadataResponse,
  VaultReadResponse,
  VaultTokenCache,
  VaultVersion,
} from "./interfaces";
import got from "got";
import { Cache, LocalStorage, open, showToast, Toast } from "@raycast/api";
import * as oauthService from "./oauth.service";
import { homedir } from "os";
import fs from "fs";
import hdate from "human-date";
import { favoritesStorageKey, getActiveVault, vaultCacheKey, VaultInstance } from "./vaults";

const NO_NAMESPACE = "<EMPTY>";

const cache = new Cache();

function vaultKey(baseKey: string): string {
  return vaultCacheKey(getActiveVault().id, baseKey);
}

export function writeEnabled(): boolean {
  return getActiveVault().enableWrite;
}

export function deleteEnabled(): boolean {
  return getActiveVault().enableDelete;
}

export function vaultTitle(suffix?: string): string {
  const { name } = getActiveVault();
  return suffix ? `${name}: ${suffix}` : name;
}

export function stringify(value: object) {
  return JSON.stringify(value, undefined, 2);
}

export function duration(date: string) {
  if (date === "") {
    return;
  }
  return hdate.relativeTime(date);
}

export function getVaultUrl(): string {
  return getActiveVault().url;
}

export function getVaultNamespaceConfiguration(): string | null | undefined {
  return cache.get(vaultKey(VAULT_NAMESPACE_CACHE_KEY));
}

export function getVaultNamespace(): string {
  const namespaceInCache = cache.get(vaultKey(VAULT_NAMESPACE_CACHE_KEY));
  if (!namespaceInCache || namespaceInCache === NO_NAMESPACE) {
    return "";
  }
  return namespaceInCache;
}

export async function setVaultNamespace(newNamespace: string) {
  const newNamespaceInCache = newNamespace === "" ? NO_NAMESPACE : newNamespace;
  cache.set(vaultKey(VAULT_NAMESPACE_CACHE_KEY), newNamespaceInCache);
  // remove cached token as namespace changes
  cache.remove(vaultKey(VAULT_TOKEN_CACHE_KEY));
  if (getActiveVault().loginMethod === "oidc") {
    await oauthService.clearTokens();
  }
}

// Forget any login for a vault, e.g. after its url or credentials change
export async function clearVaultTokens(vault: VaultInstance) {
  cache.remove(vaultCacheKey(vault.id, VAULT_TOKEN_CACHE_KEY));
  await oauthService.clearTokens(vault);
}

export function setSecretEngine(secretEngine: string) {
  cache.set(vaultKey(VAULT_SECRET_ENGINE_CACHE_KEY), secretEngine);
}

export function getSecretEngine(): string {
  const secretEngineInCache = cache.get(vaultKey(VAULT_SECRET_ENGINE_CACHE_KEY));
  if (!secretEngineInCache) {
    return getActiveVault().secretEngine;
  }
  return secretEngineInCache;
}

export function getTechnicalPaths(): string[] {
  const { technicalPaths } = getActiveVault();
  return technicalPaths ? technicalPaths.split(" ") : [];
}

export function getFavoriteNamespaces(): string[] {
  const { favoriteNamespaces } = getActiveVault();
  return favoriteNamespaces ? favoriteNamespaces.split(" ") : [];
}

export async function getUserToken(): Promise<string> {
  const vault = getActiveVault();
  if (vault.loginMethod === "oidc") {
    return await oauthService.authorize();
  }
  if (vault.loginMethod === "token") {
    return vault.token ?? "";
  }
  const tokenCache = parseTokenFromCache();
  return tokenCache ? tokenCache.token : "";
}

export function parseTokenFromCache(): VaultTokenCache | undefined {
  const tokenCacheString = cache.get(vaultKey(VAULT_TOKEN_CACHE_KEY));
  if (tokenCacheString) {
    return JSON.parse(tokenCacheString) as VaultTokenCache;
  }
}

function nothingFound(error: any) {
  return error?.response?.statusCode === 404 && error?.response?.body?.errors?.length === 0;
}

export class ConfigurationError extends Error {}

export async function getVaultClient(): Promise<NodeVault.client> {
  let tokenCache = parseTokenFromCache();

  // check cache expiration
  if (tokenCache) {
    if (Date.now() > tokenCache.expiration) {
      // token expired, removing from cache
      cache.remove(vaultKey(VAULT_TOKEN_CACHE_KEY));
      console.info("Token expired, removing from cache");
      tokenCache = undefined;
    }
  }

  // get token if needed
  const vault = getActiveVault();
  let token;
  if (tokenCache) {
    token = tokenCache.token;
  } else {
    if (vault.loginMethod === "ldap") {
      if (!vault.ldap || !vault.password) {
        throw new ConfigurationError(`Ldap method needs ldap and password to be set for vault ${vault.name}`);
      }
      console.info("Login with ldap...");
      const body = await callLoginWithLdap();
      // set token cache
      tokenCache = {
        token: body.auth.client_token,
        expiration: Date.now() + body.auth.lease_duration * 1000,
      };
      // and save it
      cache.set(vaultKey(VAULT_TOKEN_CACHE_KEY), JSON.stringify(tokenCache));
      console.info("Logged successfully, saving token in cache");
      token = tokenCache.token;
    } else if (vault.loginMethod === "token") {
      if (!vault.token) {
        throw new ConfigurationError(`Token method needs token to be set for vault ${vault.name}`);
      }
      token = vault.token;
    } else if (vault.loginMethod === "oidc") {
      token = await oauthService.authorize();
    } else {
      throw new Error("Unknown login method");
    }
  }

  // return node vault client
  return NodeVault({
    apiVersion: "v1",
    endpoint: getVaultUrl(),
    namespace: getVaultNamespace(),
    token: token,
    noCustomHTTPVerbs: true,
  });
}

function env(secret: any): string {
  let result = "";
  for (const key of Object.keys(secret)) {
    result += key + "=" + secret[key] + "\n";
  }
  return result;
}

export async function exportSecretToFile(secret: object, path: string, mode: ExportMode) {
  const toast = await showToast({
    style: Toast.Style.Animated,
    title: "Saving secret",
  });
  if (secret) {
    const filePath = `${homedir()}/Downloads/secret${path.replaceAll("/", "_")}.${mode}`;
    const content = mode === ExportMode.json ? stringify(secret) : env(secret);
    fs.writeFile(filePath, content, async (err: any) => {
      if (err) {
        toast.style = Toast.Style.Failure;
        toast.message = "Failed to save secret to " + filePath + "\n" + String(err);
      } else {
        toast.style = Toast.Style.Success;
        toast.message = "Secret saved to " + filePath;
        await open(filePath);
      }
    });
  } else {
    toast.style = Toast.Style.Failure;
    toast.message = "Nothing to save";
  }
}

export async function callTree(path: string): Promise<VaultListEntry[]> {
  console.info("Calling tree", path);
  try {
    const response = await (await getVaultClient()).list(getSecretEngine() + "/metadata" + path, {});
    const favorites = (await listFavorites()).map(({ key }) => key);
    return response.data.keys.map((key: string) => ({
      key: path + key,
      label: key,
      folder: key.endsWith("/"),
      favorite: favorites.includes(path + key),
    }));
  } catch (error) {
    console.log(">>>", error);
    if (nothingFound(error)) {
      return [];
    }
    throw error;
  }
}

export async function callRead(path: string): Promise<VaultReadResponse> {
  console.info("Calling read", path);
  const response = await (await getVaultClient()).read(getSecretEngine() + "/data" + path, {});
  return response.data;
}

export async function callReadMetadata(path: string): Promise<VaultReadMetadataResponse> {
  console.info("Calling read metadata", path);
  const response = await (await getVaultClient()).read(getSecretEngine() + "/metadata" + path, {});
  let currentVersion: VaultVersion | undefined;
  const versions = Object.getOwnPropertyNames(response.data.versions)
    .map((versionStr) => {
      const version = parseInt(versionStr, 10);
      const tmp = response.data.versions[version];
      const result: VaultVersion = {
        version: version,
        created_time: tmp.created_time,
        deletion_time: tmp.deletion_time,
        destroyed: tmp.destroyed,
        deleted: tmp.deletion_time !== "",
      };
      if (response.data.current_version === version) {
        currentVersion = result;
      }
      return result;
    })
    .sort((a, b) => b.version - a.version);
  if (!currentVersion) {
    throw new Error("Could not find current version in versions list");
  }
  return {
    current_version: currentVersion,
    versions: versions,
  };
}

export async function callWrite(path: string, newSecret: object): Promise<VaultMetaDataResponse> {
  console.info("Calling write", path);
  const response = await (await getVaultClient()).write(getSecretEngine() + "/data" + path, { data: newSecret }, {});
  return response.data;
}

export async function callDelete(path: string, deleteMode: DeleteMode, version?: number) {
  console.info("Calling delete", path, deleteMode);
  if (deleteMode === DeleteMode.deleteVersion) {
    await (await getVaultClient()).delete(getSecretEngine() + "/data" + path, {});
  } else if (deleteMode === DeleteMode.destroyVersion) {
    if (!version) {
      throw new Error("Version is mandatory to destroy specific version");
    }
    await (
      await getVaultClient()
    ).request({
      path: "/" + getSecretEngine() + "/destroy" + path,
      method: "POST",
      json: {
        versions: [version],
      },
    });
  } else if (deleteMode === DeleteMode.destroyAllVersions) {
    await (await getVaultClient()).delete(getSecretEngine() + "/metadata" + path, {});
  }
}

export async function callUndelete(path: string, version?: number) {
  console.info("Calling undelete", path);
  if (!version) {
    throw new Error("Version is mandatory to undelete specific version");
  }
  await (
    await getVaultClient()
  ).request({
    path: "/" + getSecretEngine() + "/undelete" + path,
    method: "POST",
    json: {
      versions: [version],
    },
  });
}

export async function callListEntities(): Promise<string[]> {
  console.info("Calling list entities");
  try {
    const response = await (
      await getVaultClient()
    ).request({
      path: "/identity/entity/id",
      method: "LIST",
    });
    return response.data.keys;
  } catch (error) {
    if (nothingFound(error)) {
      return [];
    }
    throw error;
  }
}

export async function callGetEntity(entityId: string): Promise<VaultEntity> {
  const response = await (
    await getVaultClient()
  ).request({
    path: "/identity/entity/id/" + entityId,
    method: "GET",
  });
  return response.data;
}

export async function callDeleteEntity(entityId: string) {
  await (
    await getVaultClient()
  ).request({
    path: "/identity/entity/id/" + entityId,
    method: "DELETE",
  });
}

export async function callCreateEntity(name: string, policies: string[]) {
  console.info("Creating entity for name: ", name);
  const response = await (
    await getVaultClient()
  ).request({
    path: "/identity/entity",
    method: "POST",
    json: {
      name: name,
      policies: policies,
    },
  });
  return response.data.id;
}

export async function callCreateAlias(entityId: string, aliasName: string, aliasMountAccessor: string) {
  console.info("Creating alias for entity: ", entityId);
  await (
    await getVaultClient()
  ).request({
    path: "/identity/entity-alias",
    method: "POST",
    json: {
      canonical_id: entityId,
      name: aliasName,
      mount_accessor: aliasMountAccessor,
    },
  });
}

export async function callGetSysAuth(): Promise<VaultMount[]> {
  const response = await (
    await getVaultClient()
  ).request({
    path: "/sys/auth",
    method: "GET",
  });
  return Object.keys(response.data).map((name) => ({
    name: name.substring(0, name.length - 1),
    type: response.data[name].type,
    description: response.data[name].description,
    accessor: response.data[name].accessor,
  }));
}

export async function callGetPolicies(): Promise<string[]> {
  const response = await (
    await getVaultClient()
  ).request({
    path: "/sys/policies/acl",
    method: "LIST",
  });
  return response.data.keys;
}

export async function callGetSysMounts(): Promise<VaultMount[]> {
  const response = await (
    await getVaultClient()
  ).request({
    path: "/sys/mounts",
    method: "GET",
  });
  return Object.keys(response.data)
    .map((name) => ({
      name: name.substring(0, name.length - 1),
      type: response.data[name].type,
      description: response.data[name].description,
      accessor: response.data[name].accessor,
    }))
    .filter((mount) => mount.type === "kv")
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function callLoginWithLdap(): Promise<VaultLoginResponse> {
  const { ldap, password } = getActiveVault();
  return got
    .post(`${getVaultUrl()}/v1/auth/ldap/login/${ldap}`, {
      json: { password },
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Namespace": getVaultNamespace(),
      },
      responseType: "json",
    })
    .json();
}

export async function callOidcAuthUrl(redirectUri: string): Promise<VaultAuthUrlResponse> {
  return got
    .post(`${getVaultUrl()}/v1/auth/oidc/oidc/auth_url`, {
      json: { redirect_uri: redirectUri },
      headers: {
        "Content-Type": "application/json",
        "X-Vault-Namespace": getVaultNamespace(),
      },
      responseType: "json",
    })
    .json();
}

export async function callLoginWthOidc(code: string, state: string): Promise<VaultLoginResponse> {
  return got
    .get(`${getVaultUrl()}/v1/auth/oidc/oidc/callback?code=${code}&state=${state}`, {
      headers: {
        "X-Vault-Namespace": getVaultNamespace(),
      },
      responseType: "json",
    })
    .json();
}

// Extends a token that hasn't expired yet by the role's TTL, up to its max TTL
export async function callRenewSelf(token: string): Promise<VaultLoginResponse> {
  return got
    .post(`${getVaultUrl()}/v1/auth/token/renew-self`, {
      json: {},
      headers: {
        "X-Vault-Token": token,
        "X-Vault-Namespace": getVaultNamespace(),
      },
      responseType: "json",
    })
    .json();
}

async function getFavoritePaths(): Promise<string[]> {
  const stored = await LocalStorage.getItem<string>(favoritesStorageKey(getActiveVault().id));
  return stored ? (JSON.parse(stored) as string[]) : [];
}

async function setFavoritePaths(paths: string[]) {
  await LocalStorage.setItem(favoritesStorageKey(getActiveVault().id), JSON.stringify(paths));
}

export async function listFavorites(): Promise<VaultListEntry[]> {
  return (await getFavoritePaths()).map((key: string) => ({
    key: key,
    label: key,
    folder: key.endsWith("/"),
    favorite: true,
  }));
}

export async function isFavorite(path: string): Promise<boolean> {
  return (await getFavoritePaths()).includes(path);
}

export async function addToFavorites(path: string, callback: () => Promise<void>) {
  const paths = await getFavoritePaths();
  if (!paths.includes(path)) {
    await setFavoritePaths([...paths, path]);
  }
  await showToast({
    style: Toast.Style.Success,
    title: "Added to favorites",
  });
  await callback();
}

export async function removeFromFavorites(path: string, callback: () => Promise<void>) {
  await setFavoritePaths((await getFavoritePaths()).filter((favorite) => favorite !== path));
  await showToast({
    style: Toast.Style.Success,
    title: "Removed from favorites",
  });
  await callback();
}
