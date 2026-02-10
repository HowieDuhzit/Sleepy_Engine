export {};

declare global {
  interface Window {
    sleepyDesktop?: {
      animations: {
        list: () => Promise<string[]>;
        load: (name: string) => Promise<{
          duration: number;
          frames: Array<{
            time: number;
            bones: Record<string, { x: number; y: number; z: number; w: number }>;
            rootPos?: { x: number; y: number; z: number };
          }>;
        } | null>;
        save: (
          name: string,
          clip: {
            duration: number;
            frames: Array<{
              time: number;
              bones: Record<string, { x: number; y: number; z: number; w: number }>;
              rootPos?: { x: number; y: number; z: number };
            }>;
          },
        ) => Promise<{ ok: boolean; file?: string; error?: string }>;
        info: () => Promise<{ animationsDir: string }>;
      };
    };
  }
}
