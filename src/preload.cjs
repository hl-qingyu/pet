const { contextBridge, ipcRenderer } = require('electron');
const invokeChannels = new Set(['bootstrap', 'config:save', 'config:open', 'history:clear', 'chat:send', 'chat:stop', 'shortcut:recording', 'dsh:account-refresh', 'sub2api:quota-refresh']);
const sendChannels = new Set(['pet:ready', 'panel:ready', 'panel:open', 'panel:hide', 'pet:interact', 'pet:menu', 'pet:hide', 'pet:hit', 'pet:drag-start', 'pet:drag', 'pet:drag-end']);
const receiveChannels = new Set(['dsh:account', 'pet:state', 'pet:cursor', 'pet:drag-direction', 'panel:repaint', 'panel:page', 'config:updated', 'runtime:updated', 'history:updated', 'chat:start', 'chat:delta', 'chat:done', 'chat:error', 'chat:idle']);
contextBridge.exposeInMainWorld('dragon', {
  invoke(channel, ...args) { if (!invokeChannels.has(channel)) throw new Error('未知请求'); return ipcRenderer.invoke(channel, ...args); },
  send(channel, ...args) { if (!sendChannels.has(channel)) throw new Error('未知操作'); ipcRenderer.send(channel, ...args); },
  on(channel, callback) {
    if (!receiveChannels.has(channel)) throw new Error('未知事件');
    const listener = (_event, data) => callback(data); ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
