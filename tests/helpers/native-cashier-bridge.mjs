// Test-only native boundaries. The mounted root, workbench and sale forms are real.
const fixture = () => globalThis[Symbol.for('member.native-ui-fixture')];
export const App = {
  async addListener(event, listener) {
    const { listeners } = fixture(); listeners.set(event, listener);
    return { async remove() { listeners.delete(event); } };
  },
  async exitApp() { fixture().exits++; }
};
export const createRelationalNativeSession = () => fixture().session;
export const createNativeWorkspace = () => fixture().workspace;
export const createNativeUpdate = () => fixture().update;
export const cloudDeviceBridge = { copyText: async () => {} };
