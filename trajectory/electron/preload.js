const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("trajectory", { desktop: true });
