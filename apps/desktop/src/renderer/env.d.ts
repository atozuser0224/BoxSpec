import type { DesktopApi } from "../common/ipc";

declare global {
  interface Window { boxspec: DesktopApi; }
}

export {};
