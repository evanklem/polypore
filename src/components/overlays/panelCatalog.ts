export type PanelMeta = { icon: string; label: string };

export type PanelManual = {
  summary: string;
  tips: string[];
  externalDocsUrl?: string;
};

export type PanelCatalogItem = {
  slot: string;
  id: string;
  icon: string;
  label: string;
  title: string;
  version: string;
  category: string;
  defaultArea?: string;
  permissions: string[];
  capabilities: string[];
  enabled: boolean;
  source: string;
  manual: PanelManual;
};
