const { app, BrowserWindow, Menu, shell, dialog, ipcMain } = require('electron');
const path = require('node:path');
const { createApp } = require('../src/http-server');
const { SafetyConfig } = require('../src/config');
const { SafetyLayer } = require('../src/safety');
const { createPortService } = require('../src/port-service');
const { startLocalServer } = require('../src/desktop-server');
const { updateFromGitHubMain } = require('../src/github-main-updater');
const { createAppInfoProvider } = require('../src/app-info');
const { createMacAppUpdater, resolveRunningAppBundle } = require('../src/app-updater');

let mainWindow;
let localServer;

async function updateFromMain() {
  if (app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'עדכון מ-GitHub',
      message: 'עדכון מ-main זמין רק להרצה מתוך עותק Git של הפרויקט.',
      detail: 'האפליקציה המותקנת אינה כוללת תיקיית .git. הורד גרסה חדשה מדף Releases של הפרויקט.',
    });
    return;
  }

  const confirmation = await dialog.showMessageBox({
    type: 'warning',
    buttons: ['עדכן והפעל מחדש', 'ביטול'],
    defaultId: 1,
    cancelId: 1,
    title: 'עדכון מ-GitHub main',
    message: 'למשוך את main מ-GitHub ולהפעיל מחדש?',
    detail: 'רק עותק נקי על ענף main של yonatan2021/ports-mcp יתעדכן. העדכון הוא fast-forward בלבד.',
  });
  if (confirmation.response !== 0) return;

  try {
    const result = await updateFromGitHubMain({ repoDir: app.getAppPath() });
    if (result.status === 'updated') {
      await dialog.showMessageBox({
        type: 'info',
        title: 'העדכון הושלם',
        message: 'קוד המקור עודכן מ-main. האפליקציה תופעל מחדש.',
      });
      app.relaunch();
      app.exit(0);
      return;
    }

    const messages = {
      'up-to-date': ['אין עדכון', 'עותק הקוד כבר תואם ל-main.'],
      dirty: ['לא ניתן לעדכן', 'יש שינויים מקומיים שלא נשמרו ב-Git. בצע commit, stash או בטל אותם לפני עדכון.'],
      'unexpected-origin': ['לא ניתן לעדכן', 'כתובת origin אינה yonatan2021/ports-mcp.'],
      'wrong-branch': ['לא ניתן לעדכן', `הענף הנוכחי הוא ${result.branch || 'לא ידוע'}. עבור ל-main לפני עדכון.`],
    };
    const [title, message] = messages[result.status] || ['עדכון נכשל', 'מצב עדכון לא מוכר.'];
    await dialog.showMessageBox({ type: result.status === 'up-to-date' ? 'info' : 'warning', title, message });
  } catch (error) {
    console.error('Could not update from GitHub main:', error);
    await dialog.showMessageBox({
      type: 'error',
      title: 'עדכון נכשל',
      message: 'לא ניתן למשוך את main מ-GitHub.',
      detail: error.message,
    });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    title: 'מנהל הפורטים שלי',
    backgroundColor: '#111827',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(localServer.url);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  const preventUntrustedNavigation = (event, url) => {
    try {
      if (new URL(url).origin !== new URL(localServer.url).origin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  };
  mainWindow.webContents.on('will-navigate', preventUntrustedNavigation);
  mainWindow.webContents.on('will-redirect', preventUntrustedNavigation);
}

function createApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'מנהל הפורטים',
      submenu: [
        { role: 'about', label: 'אודות מנהל הפורטים' },
        { type: 'separator' },
        { role: 'hide', label: 'הסתר' },
        { role: 'hideOthers', label: 'הסתר אחרים' },
        { role: 'unhide', label: 'הצג הכל' },
        { type: 'separator' },
        app.isPackaged
          ? { label: 'בדוק עדכונים…', click: () => mainWindow?.reload() }
          : { label: 'עדכון מ-GitHub main…', click: updateFromMain },
        { type: 'separator' },
        { role: 'quit', label: 'סגור מנהל הפורטים' },
      ],
    },
    {
      label: 'תצוגה',
      submenu: [
        { role: 'reload', label: 'רענן' },
        { role: 'toggleDevTools', label: 'כלי פיתוח' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'איפוס גודל' },
        { role: 'zoomIn', label: 'הגדל' },
        { role: 'zoomOut', label: 'הקטן' },
      ],
    },
  ]));
}

app.whenReady().then(async () => {
  const config = new SafetyConfig();
  const safetyLayer = new SafetyLayer({ config });
  const service = createPortService({ safetyLayer });
  const targetApp = process.platform === 'darwin' && app.isPackaged
    ? resolveRunningAppBundle(process.execPath)
    : null;
  const updater = targetApp
    ? createMacAppUpdater({
        currentVersion: app.getVersion(),
        arch: process.arch,
        targetApp,
        tempDir: app.getPath('temp'),
      })
    : null;
  const getBaseAppInfo = createAppInfoProvider({ currentVersion: app.getVersion() });
  const getAppInfo = async () => ({
    ...(await getBaseAppInfo()),
    updateSupported: Boolean(updater),
  });
  localServer = await startLocalServer({
    app: createApp({ service, safetyLayer, config, getAppInfo }),
  });

  const trustedRendererOrigin = new URL(localServer.url).origin;
  ipcMain.handle('app-update', async (event) => {
    let senderOrigin;
    try {
      senderOrigin = new URL(event.senderFrame.url).origin;
    } catch {
      throw new Error('Update request came from an invalid renderer');
    }
    if (senderOrigin !== trustedRendererOrigin) {
      throw new Error('Update request came from an untrusted renderer');
    }
    if (!updater) throw new Error('In-app update is not available');

    const result = await updater.apply();
    if (result.handedOff) setTimeout(() => app.quit(), 750);
    return result;
  });

  createApplicationMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch((error) => {
  console.error('Could not start Port Manager:', error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  ipcMain.removeHandler('app-update');
  if (localServer) localServer.close().catch((error) => console.error('Could not stop local server:', error));
});
