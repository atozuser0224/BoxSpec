import { contextBridge, ipcRenderer } from "electron";
import { IPC, type DesktopApi } from "../common/ipc";

const invoke = <T>(channel: string, input?: unknown): Promise<T> => ipcRenderer.invoke(channel, input) as Promise<T>;

const api: DesktopApi = {
  bootstrap: () => invoke(IPC.bootstrap),
  chooseDirectory: () => invoke(IPC.chooseDirectory),
  createProject: (input) => invoke(IPC.projectCreate, input),
  openProject: (input) => invoke(IPC.projectOpen, input),
  createScreen: (input) => invoke(IPC.screenCreate, input),
  openScreen: (input) => invoke(IPC.screenOpen, input),
  executeCommand: (input) => invoke(IPC.screenCommand, input),
  undo: (input) => invoke(IPC.screenUndo, input),
  redo: (input) => invoke(IPC.screenRedo, input),
  saveScreen: (input) => invoke(IPC.screenSave, input),
  listLayoutDrafts: (input) => invoke(IPC.draftList, input),
  openLayoutDraft: (input) => invoke(IPC.draftOpen, input),
  updateLayoutDraft: (input) => invoke(IPC.draftCommand, input),
  publishLayoutDraft: (input) => invoke(IPC.draftPublish, input),
  listThemes: (input) => invoke(IPC.themeList, input),
  applyThemeToDraft: (input) => invoke(IPC.themeApplyDraft, input),
  applyThemeToScreen: (input) => invoke(IPC.themeApplyScreen, input),
  openThemeSource: (input) => invoke(IPC.themeOpenSource, input),
  listReviews: (input) => invoke(IPC.reviewList, input),
  openReview: (input) => invoke(IPC.reviewOpen, input),
  approveAndApply: (input) => invoke(IPC.reviewApproveApply, input),
  inspectRecovery: (input) => invoke(IPC.recoveryInspect, input),
  resolveRecovery: (input) => invoke(IPC.recoveryResolve, input),
  inspectDrift: (input) => invoke(IPC.driftInspect, input),
  resolveDrift: (input) => invoke(IPC.driftResolve, input),
  clientStatus: (input) => invoke(IPC.clientStatus, input),
  generateClientConfig: (input) => invoke(IPC.clientGenerate, input),
  applyClientConfig: (input) => invoke(IPC.clientApply, input),
  diagnoseClient: (input) => invoke(IPC.clientDiagnose, input),
  pairClient: (input) => invoke(IPC.clientPair, input),
};

contextBridge.exposeInMainWorld("boxspec", Object.freeze(api));
