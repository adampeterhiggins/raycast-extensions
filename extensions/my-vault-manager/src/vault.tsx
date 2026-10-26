import { LaunchProps, List } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { getLastActiveVaultId, listVaults, setActiveVault } from "./vaults";
import { VaultHome, VaultList } from "./components/vaults";

export default function Vault(props: LaunchProps<{ launchContext: { vaultId?: string } }>) {
  const { data: vault, isLoading } = usePromise(async () => {
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
