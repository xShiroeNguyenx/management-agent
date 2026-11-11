// Snapshot ghi boi media/statusline-bridge.cjs (doc tu status line cua Claude Code).
// Cac truong deu optional vi rate_limits chi xuat hien voi tai khoan Pro/Max va
// chi sau phan hoi dau tien cua phien.
export interface LiveUsage {
  updatedAt: number; // epoch ms
  model?: string;
  rateLimits?: {
    fiveHourPct?: number;
    fiveHourResetsAt?: number; // epoch seconds
    sevenDayPct?: number;
    sevenDayResetsAt?: number; // epoch seconds
  };
  contextPct?: number;
  costUsd?: number;
}
