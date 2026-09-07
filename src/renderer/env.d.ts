/// <reference types="vite/client" />

import type { EarshotApi } from "../shared/types";

declare global {
  interface Window {
    earshot: EarshotApi;
  }
}

export {};
