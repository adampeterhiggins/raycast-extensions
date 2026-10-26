import { useState } from "react";
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  confirmAlert,
  environment,
  Form,
  Icon,
  List,
  showToast,
  Toast,
  useNavigation,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import {
  deleteVault,
  getActiveVaultOrUndefined,
  importVaults,
  listVaults,
  LoginMethod,
  saveVault,
  setActiveVault,
  VAULT_COLORS,
  VaultColor,
  vaultIcon,
  VaultImport,
  VaultInstance,
} from "../vaults";
import { clearVaultTokens, getVaultNamespaceConfiguration } from "../utils";
import { VaultNamespace } from "./namespace";
import { VaultTree } from "./tree";

// Author from package.json, used to build deeplinks back into this extension
const EXTENSION_AUTHOR = "fonimus";

function vaultDeeplink(vault: VaultInstance): string {
  const context = encodeURIComponent(JSON.stringify({ vaultId: vault.id }));
  return `raycast://extensions/${EXTENSION_AUTHOR}/${environment.extensionName}/vault?launchContext=${context}`;
}

export function VaultHome() {
  return getVaultNamespaceConfiguration() === undefined ? <VaultNamespace /> : <VaultTree path={"/"} />;
}

export function VaultList() {
  const { push } = useNavigation();
  const { data: vaults = [], isLoading, revalidate } = usePromise(listVaults);
  const activeVaultId = getActiveVaultOrUndefined()?.id;

  async function openVault(vault: VaultInstance) {
    await setActiveVault(vault);
    push(<VaultHome />);
  }

  async function removeVault(vault: VaultInstance) {
    if (
      await confirmAlert({
        title: `Delete ${vault.name}?`,
        message: "Its settings and favorites will be removed from this extension.",
        icon: Icon.Trash,
        primaryAction: { title: "Delete", style: Alert.ActionStyle.Destructive },
      })
    ) {
      await deleteVault(vault.id);
      await showToast({ style: Toast.Style.Success, title: `Deleted ${vault.name}` });
      await revalidate();
    }
  }

  const addVault = (
    <Action.Push
      icon={Icon.Plus}
      title="Add Vault"
      shortcut={{ modifiers: ["cmd"], key: "n" }}
      target={<VaultForm onSave={revalidate} />}
    />
  );

  return (
    <List isLoading={isLoading} navigationTitle="Vaults" searchBarPlaceholder="Search vaults">
      <List.EmptyView
        icon={Icon.Lock}
        title="No vaults configured"
        description="Add a Vault instance to get started"
        actions={<ActionPanel>{addVault}</ActionPanel>}
      />
      {vaults.map((vault) => (
        <List.Item
          key={vault.id}
          icon={vaultIcon(vault)}
          title={vault.name}
          subtitle={vault.url}
          accessories={[
            ...(!vault.enableWrite && !vault.enableDelete ? [{ tag: { value: "read-only", color: Color.Green } }] : []),
            ...(vault.enableDelete ? [{ tag: { value: "delete enabled", color: Color.Red } }] : []),
            { tag: vault.loginMethod },
            ...(vault.id === activeVaultId ? [{ icon: Icon.Checkmark, tooltip: "Current vault" }] : []),
          ]}
          actions={
            <ActionPanel>
              <Action icon={Icon.ArrowRight} title="Open Vault" onAction={() => openVault(vault)} />
              <Action.Push
                icon={Icon.Pencil}
                title="Edit Vault"
                shortcut={{ modifiers: ["cmd"], key: "e" }}
                target={<VaultForm vault={vault} onSave={revalidate} />}
              />
              {addVault}
              <Action.CreateQuicklink
                title="Create Quicklink for Vault"
                shortcut={{ modifiers: ["cmd", "shift"], key: "q" }}
                quicklink={{ name: `Vault: ${vault.name}`, link: vaultDeeplink(vault) }}
              />
              {/* The current vault backs the screens behind this one, so it can't be deleted from here */}
              {vault.id !== activeVaultId && (
                <Action
                  icon={Icon.Trash}
                  title="Delete Vault"
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => removeVault(vault)}
                />
              )}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

interface VaultFormValues {
  name: string;
  color: string;
  url: string;
  secretEngine: string;
  loginMethod: string;
  ldap?: string;
  password?: string;
  token?: string;
  technicalPaths?: string;
  favoriteNamespaces?: string;
  enableWrite: boolean;
  enableDelete: boolean;
}

export function VaultForm(props: { vault?: VaultInstance; onSave?: () => unknown }) {
  const { vault, onSave } = props;
  const { pop } = useNavigation();
  const [loginMethod, setLoginMethod] = useState<LoginMethod>(vault?.loginMethod ?? "oidc");
  const [nameError, setNameError] = useState<string | undefined>();
  const [urlError, setUrlError] = useState<string | undefined>();

  async function submit(values: VaultFormValues) {
    const name = values.name.trim();
    const url = values.url.trim();
    setNameError(name ? undefined : "Name is required");
    setUrlError(/^https?:\/\/.+/.test(url) ? undefined : "Enter a URL like https://vault.example.com");
    if (!name || !/^https?:\/\/.+/.test(url)) {
      return;
    }
    const saved = await saveVault({
      id: vault?.id,
      name,
      color: values.color as VaultColor,
      url,
      secretEngine: values.secretEngine.trim() || "secret",
      loginMethod: values.loginMethod as LoginMethod,
      ldap: values.ldap?.trim() || undefined,
      password: values.password || undefined,
      token: values.token || undefined,
      technicalPaths: values.technicalPaths?.trim() || undefined,
      favoriteNamespaces: values.favoriteNamespaces?.trim() || undefined,
      enableWrite: values.enableWrite,
      enableDelete: values.enableDelete,
    });
    if (
      vault &&
      (["url", "loginMethod", "ldap", "password", "token"] as const).some((field) => vault[field] !== saved[field])
    ) {
      await clearVaultTokens(saved);
    }
    await showToast({ style: Toast.Style.Success, title: `Saved ${saved.name}` });
    await onSave?.();
    pop();
  }

  return (
    <Form
      navigationTitle={vault ? `Edit ${vault.name}` : "Add Vault"}
      actions={
        <ActionPanel>
          <Action.SubmitForm icon={Icon.Check} title="Save Vault" onSubmit={submit} />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="name"
        title="Name"
        placeholder="Prod"
        defaultValue={vault?.name}
        error={nameError}
        onChange={() => setNameError(undefined)}
      />
      <Form.Dropdown id="color" title="Color" defaultValue={vault?.color ?? "blue"}>
        {Object.entries(VAULT_COLORS).map(([key, color]) => (
          <Form.Dropdown.Item
            key={key}
            value={key}
            title={key[0].toUpperCase() + key.slice(1)}
            icon={{ source: Icon.CircleFilled, tintColor: color }}
          />
        ))}
      </Form.Dropdown>
      <Form.TextField
        id="url"
        title="Vault URL"
        placeholder="https://vault.example.com"
        defaultValue={vault?.url}
        error={urlError}
        onChange={() => setUrlError(undefined)}
      />
      <Form.TextField
        id="secretEngine"
        title="Secret Engine"
        info="Used only if not set by the 'List Engines' action"
        defaultValue={vault?.secretEngine ?? "secret"}
      />
      <Form.Separator />
      <Form.Dropdown
        id="loginMethod"
        title="Login Method"
        value={loginMethod}
        onChange={(value) => setLoginMethod(value as LoginMethod)}
      >
        <Form.Dropdown.Item value="oidc" title="Oidc" />
        <Form.Dropdown.Item value="ldap" title="Ldap" />
        <Form.Dropdown.Item value="token" title="Token" />
      </Form.Dropdown>
      {loginMethod === "ldap" && (
        <>
          <Form.TextField id="ldap" title="Ldap" info="Ldap identifier" defaultValue={vault?.ldap} />
          <Form.PasswordField id="password" title="Password" defaultValue={vault?.password} />
        </>
      )}
      {loginMethod === "token" && <Form.PasswordField id="token" title="Token" defaultValue={vault?.token} />}
      <Form.Separator />
      <Form.TextField
        id="technicalPaths"
        title="Technical Paths"
        info="Technical paths to hide, separated by space"
        defaultValue={vault?.technicalPaths}
      />
      <Form.TextField
        id="favoriteNamespaces"
        title="Favorite Namespaces"
        info="Favorite namespaces, separated by space (for easy switch)"
        defaultValue={vault?.favoriteNamespaces}
      />
      <Form.Checkbox id="enableWrite" label="Enable write" defaultValue={vault?.enableWrite ?? true} />
      <Form.Checkbox id="enableDelete" label="Enable delete" defaultValue={vault?.enableDelete ?? false} />
    </Form>
  );
}

// Deeplinks can come from anywhere, so show what would be imported and wait for the user to confirm
export function VaultImportConfirmation(props: { vaults: VaultImport[] }) {
  const { push } = useNavigation();

  async function confirmImport() {
    try {
      const imported = await importVaults(props.vaults);
      await showToast({ style: Toast.Style.Success, title: `Imported ${imported.map(({ name }) => name).join(", ")}` });
      push(<VaultList />);
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Could not import vaults", message: String(error) });
    }
  }

  return (
    <List navigationTitle="Import Vaults" searchBarPlaceholder="Review the vaults to import">
      <List.Section title={`Import ${props.vaults.length} vault${props.vaults.length === 1 ? "" : "s"}?`}>
        {props.vaults.map((vault, index) => (
          <List.Item
            key={`${vault.url}-${index}`}
            icon={{ source: Icon.CircleFilled, tintColor: VAULT_COLORS[vault.color ?? "blue"] ?? Color.Blue }}
            title={String(vault.name)}
            subtitle={String(vault.url)}
            accessories={[
              ...(vault.enableWrite === false ? [{ tag: { value: "read-only", color: Color.Green } }] : []),
              { tag: vault.loginMethod ?? "oidc" },
            ]}
            actions={
              <ActionPanel>
                <Action icon={Icon.Download} title="Import Vaults" onAction={confirmImport} />
                <Action.Push icon={Icon.XMarkCircle} title="Cancel" target={<VaultList />} />
              </ActionPanel>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}
