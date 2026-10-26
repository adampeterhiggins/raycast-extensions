import { Color, Icon, LocalStorage } from "@raycast/api";
import { randomUUID } from "crypto";

export type LoginMethod = "oidc" | "ldap" | "token";

export interface VaultInstance {
  id: string;
  name: string;
  color: VaultColor;
  url: string;
  secretEngine: string;
  loginMethod: LoginMethod;
  ldap?: string;
  password?: string;
  token?: string;
  technicalPaths?: string;
  favoriteNamespaces?: string;
  enableWrite: boolean;
  enableDelete: boolean;
}

export const VAULT_COLORS = {
  blue: Color.Blue,
  green: Color.Green,
  yellow: Color.Yellow,
  orange: Color.Orange,
  red: Color.Red,
  purple: Color.Purple,
  magenta: Color.Magenta,
} as const;

export type VaultColor = keyof typeof VAULT_COLORS;

const VAULTS_STORAGE_KEY = "vaults";
const ACTIVE_VAULT_STORAGE_KEY = "active-vault-id";

// Each command launch works against a single vault at a time, so the selected one is kept in module state
// and read synchronously by the vault client helpers in utils.ts
let activeVault: VaultInstance | undefined;

export class NoActiveVaultError extends Error {
  constructor() {
    super("No vault selected");
  }
}

export function getActiveVault(): VaultInstance {
  if (!activeVault) {
    throw new NoActiveVaultError();
  }
  return activeVault;
}

export function getActiveVaultOrUndefined(): VaultInstance | undefined {
  return activeVault;
}

export async function setActiveVault(vault: VaultInstance) {
  activeVault = vault;
  await LocalStorage.setItem(ACTIVE_VAULT_STORAGE_KEY, vault.id);
}

export async function getLastActiveVaultId(): Promise<string | undefined> {
  return LocalStorage.getItem<string>(ACTIVE_VAULT_STORAGE_KEY);
}

export async function listVaults(): Promise<VaultInstance[]> {
  const stored = await LocalStorage.getItem<string>(VAULTS_STORAGE_KEY);
  return stored ? (JSON.parse(stored) as VaultInstance[]) : [];
}

async function storeVaults(vaults: VaultInstance[]) {
  await LocalStorage.setItem(VAULTS_STORAGE_KEY, JSON.stringify(vaults));
}

export async function saveVault(vault: Omit<VaultInstance, "id"> & { id?: string }): Promise<VaultInstance> {
  const vaults = await listVaults();
  const saved: VaultInstance = { ...vault, url: vault.url.replace(/\/$/, ""), id: vault.id ?? randomUUID() };
  const index = vaults.findIndex((existing) => existing.id === saved.id);
  if (index === -1) {
    vaults.push(saved);
  } else {
    vaults[index] = saved;
  }
  await storeVaults(vaults);
  if (activeVault?.id === saved.id) {
    activeVault = saved;
  }
  return saved;
}

export async function deleteVault(id: string) {
  await storeVaults((await listVaults()).filter((vault) => vault.id !== id));
  await LocalStorage.removeItem(favoritesStorageKey(id));
  if (activeVault?.id === id) {
    activeVault = undefined;
    await LocalStorage.removeItem(ACTIVE_VAULT_STORAGE_KEY);
  }
}

export function favoritesStorageKey(vaultId: string): string {
  return `vault:${vaultId}:favorites`;
}

export function vaultCacheKey(vaultId: string, baseKey: string): string {
  return `vault:${vaultId}:${baseKey}`;
}

export function vaultIcon(vault: VaultInstance) {
  return { source: Icon.CircleFilled, tintColor: VAULT_COLORS[vault.color] };
}

export type VaultImport = Partial<Omit<VaultInstance, "id">> & Pick<VaultInstance, "name" | "url">;

function isVaultImport(value: unknown): value is VaultImport {
  const candidate = value as VaultImport;
  return (
    typeof candidate?.name === "string" &&
    candidate.name.trim() !== "" &&
    typeof candidate.url === "string" &&
    /^https?:\/\/.+/.test(candidate.url)
  );
}

// Adds vaults passed in a deeplink's launch context, updating any existing vault with the same url
export async function importVaults(input: unknown): Promise<VaultInstance[]> {
  if (!Array.isArray(input) || !input.every(isVaultImport)) {
    throw new Error("Each vault to import needs a name and an http(s) url");
  }
  const existing = await listVaults();
  const imported: VaultInstance[] = [];
  for (const vault of input) {
    const url = vault.url.replace(/\/$/, "");
    const match = existing.find((candidate) => candidate.url === url);
    imported.push(
      await saveVault({
        ...match,
        name: vault.name.trim(),
        url,
        color: vault.color && vault.color in VAULT_COLORS ? vault.color : match?.color ?? "blue",
        secretEngine: vault.secretEngine ?? match?.secretEngine ?? "secret",
        loginMethod: vault.loginMethod ?? match?.loginMethod ?? "oidc",
        ldap: vault.ldap ?? match?.ldap,
        password: vault.password ?? match?.password,
        token: vault.token ?? match?.token,
        technicalPaths: vault.technicalPaths ?? match?.technicalPaths,
        favoriteNamespaces: vault.favoriteNamespaces ?? match?.favoriteNamespaces,
        enableWrite: vault.enableWrite ?? match?.enableWrite ?? true,
        enableDelete: vault.enableDelete ?? match?.enableDelete ?? false,
      })
    );
  }
  return imported;
}
