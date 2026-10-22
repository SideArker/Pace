import { useEffect, useState } from "react";

const workingTips = [
  "Type / to browse commands",
  "Use /context to check thread size",
  "Use /tasks to review current steps",
  "Send another prompt to queue it",
  "Ctrl+O toggles command and reasoning details",
  "Use /models to adjust available routes",
] as const;

export function useWorkingTip(busy: boolean, sessionId: string | undefined) {
  const [workingTip, setWorkingTip] = useState<string>();
  useEffect(() => {
    setWorkingTip(undefined);
    if (!busy) return;
    let previous = Math.floor(Math.random() * workingTips.length);
    let interval: ReturnType<typeof setInterval> | undefined;
    const chooseTip = () => {
      const offset = 1 + Math.floor(Math.random() * (workingTips.length - 1));
      previous = (previous + offset + workingTips.length) % workingTips.length;
      setWorkingTip(workingTips[previous]);
    };
    const delay = setTimeout(() => { chooseTip(); interval = setInterval(chooseTip, 15_000); }, 8_000);
    return () => { clearTimeout(delay); if (interval) clearInterval(interval); };
  }, [busy, sessionId]);
  return workingTip;
}
