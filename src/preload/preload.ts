import { contextBridge, ipcRenderer } from 'electron';

const EVENTS = new Set(['state', 'command', 'ai', 'found']);

contextBridge.exposeInMainWorld('marigold', {
  invoke: (name: string, payload?: unknown) => ipcRenderer.invoke('invoke', name, payload),
  on: (event: string, cb: (data: unknown) => void) => {
    if (!EVENTS.has(event)) throw new Error(`unknown event ${event}`);
    const listener = (_e: unknown, data: unknown) => cb(data);
    ipcRenderer.on(event, listener);
    return () => ipcRenderer.removeListener(event, listener);
  },
});
