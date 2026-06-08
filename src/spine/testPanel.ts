import { createLoopbackHost, type PolyporeHost, type RpcResponse } from '../../packages/sdk/src/host';
import { HostRpcServer, type HostNotification } from '../../packages/host/src';
import type { PanelManifest } from '../../packages/sdk/src';

export const testPanelManifest: PanelManifest = {
  schemaVersion: 1,
  id: 'polypore.test-panel',
  title: 'test panel',
  icon: 'tp',
  version: '0.1.0',
  entry: 'loopback',
  permissions: ['ui.notify'],
  capabilities: [],
  category: 'other',
  defaultArea: 'center',
  manual: {
    summary: 'loopback panel used to verify host rpc validation.',
    tips: ['calls ui.notify through the generated schema validators'],
  },
};

export type TestPanelResult = {
  manifests: PanelManifest[];
  notifications: HostNotification[];
  malformed: RpcResponse;
};

export async function runTestPanel(server: HostRpcServer): Promise<TestPanelResult> {
  const host: PolyporeHost = createLoopbackHost((request) => server.handle(request));
  await host.registerManifest(testPanelManifest);
  await host.ui.notify('info', 'hello');
  const malformed = await host.raw({ method: 'ui.notify', params: { level: 'info' } });
  return {
    manifests: server.listManifests(),
    notifications: server.listNotifications(),
    malformed,
  };
}
