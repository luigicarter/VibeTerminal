// Native application menu (File / Edit / View). Menu clicks are forwarded to the
// renderer as "menu:event" broadcasts — the same push pattern as "updates:event"
// and "terminal:event" — so all behavior (new pane, settings dialog, sidebar
// toggle) stays implemented once, in the renderer.

const { app, Menu } = require("electron");

function buildApplicationMenu({ send }) {
  const isMac = process.platform === "darwin";
  const action = (name) => () => send({ type: "action", action: name });

  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Terminal", click: action("new-terminal") },
        { label: "New Claude Pane", click: action("new-claude") },
        { label: "Open Claude Code", click: action("open-claude-code") },
        { type: "separator" },
        {
          label: "Settings…",
          accelerator: "CmdOrCtrl+,",
          click: action("open-settings")
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" }
      ]
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", click: action("toggle-sidebar") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "reload" },
        ...(app.isPackaged ? [] : [{ role: "toggleDevTools" }])
      ]
    }
  ];

  return Menu.buildFromTemplate(template);
}

function installApplicationMenu(mainWindow) {
  const send = (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("menu:event", message);
    }
  };
  Menu.setApplicationMenu(buildApplicationMenu({ send }));
}

module.exports = { installApplicationMenu };
