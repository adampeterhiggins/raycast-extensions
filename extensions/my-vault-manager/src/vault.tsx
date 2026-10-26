import { Alert, confirmAlert, Icon, LaunchProps, List, showToast, Toast } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getLastActiveVaultId, importVaults, listVaults, setActiveVault, VaultImport } from "./vaults";
import { VaultHome, VaultList } from "./components/vaults";

interface VaultLaunchContext {
  vaultId?: string;
  importVaults?: VaultImport[];
}

// Deeplinks can come from anywhere, so ask before adding vaults from one
async function confirmAndImport(vaults: VaultImport[]): Promise<boolean> {
  try {
    const confirmed = await confirmAlert({
      title: `Import ${vaults.length} vault${vaults.length === 1 ? "" : "s"}?`,
      message: vaults.map((vault) => `${vault.name}: ${vault.url}`).join("\n"),
      icon: Icon.Download,
      primaryAction: { title: "Import", style: Alert.ActionStyle.Default },
    });
    if (!confirmed) {
      return false;
    }
    const imported = await importVaults(vaults);
    await showToast({ style: Toast.Style.Success, title: `Imported ${imported.map(({ name }) => name).join(", ")}` });
    return true;
  } catch (error) {
    await showToast({ style: Toast.Style.Failure, title: "Could not import vaults", message: String(error) });
    return false;
  }
}

export default function Vault(props: LaunchProps<{ launchContext: VaultLaunchContext }>) {
  const { data: vault, isLoading } = usePromise(async () => {
    if (props.launchContext?.importVaults) {
      await confirmAndImport(props.launchContext.importVaults);
      return undefined;
    }
    const vaults = await listVaults();
    const vaultId = props.launchContext?.vaultId ?? (await getLastActiveVaultId());
    const vault = vaults.find(({ id }) => id === vaultId) ?? (vaults.length === 1 ? vaults[0] : undefined);
    if (vault) {
      await setActiveVault(vault);
    }
    return vault;
  });

  if (isLoading) {
    return <List isLoading />;
  }
  return vault ? <VaultHome /> : <VaultList />;
}
