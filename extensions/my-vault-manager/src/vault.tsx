import { LaunchProps, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getLastActiveVaultId, listVaults, setActiveVault, VaultImport } from "./vaults";
import { VaultHome, VaultImportConfirmation, VaultList } from "./components/vaults";

interface VaultLaunchContext {
  vaultId?: string;
  importVaults?: VaultImport[];
}

export default function Vault(props: LaunchProps<{ launchContext: VaultLaunchContext }>) {
  const vaultsToImport = props.launchContext?.importVaults;
  const { data: vault, isLoading } = usePromise(
    async () => {
      const vaults = await listVaults();
      const vaultId = props.launchContext?.vaultId ?? (await getLastActiveVaultId());
      const vault = vaults.find(({ id }) => id === vaultId) ?? (vaults.length === 1 ? vaults[0] : undefined);
      if (vault) {
        await setActiveVault(vault);
      }
      return vault;
    },
    [],
    { execute: !vaultsToImport }
  );

  if (vaultsToImport) {
    return <VaultImportConfirmation vaults={vaultsToImport} />;
  }
  if (isLoading) {
    return <List isLoading />;
  }
  return vault ? <VaultHome /> : <VaultList />;
}
