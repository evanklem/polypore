import type { PanelManifest } from '../../sdk/src';
import { validateSchema } from '../../sdk/src/validators.gen';

export type InstalledPlugin = {
  manifest: PanelManifest;
  enabled: boolean;
  source: string;
};

export class PluginStore {
  private installed = new Map<string, InstalledPlugin>();

  inspect(manifest: PanelManifest) {
    return validateSchema('manifest.schema.json', manifest);
  }

  install(manifest: PanelManifest, source: string) {
    const validation = this.inspect(manifest);
    if (!validation.ok) return validation;
    this.installed.set(manifest.id, { manifest, source, enabled: false });
    return { ok: true as const, plugin: this.installed.get(manifest.id)! };
  }

  enable(id: string) {
    const plugin = this.installed.get(id);
    if (!plugin) return false;
    plugin.enabled = true;
    return true;
  }

  disable(id: string) {
    const plugin = this.installed.get(id);
    if (!plugin) return false;
    plugin.enabled = false;
    return true;
  }

  uninstall(id: string) {
    return this.installed.delete(id);
  }

  list() {
    return [...this.installed.values()];
  }
}
