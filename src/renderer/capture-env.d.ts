declare global {
  interface Window {
    capture: {
      begin: () => Promise<{ sourceId: string }>;
      ready: () => void;
      failed: (message: string) => void;
      sendPcm: (track: string, pcm: Uint8Array) => void;
    };
  }
}

export {};
