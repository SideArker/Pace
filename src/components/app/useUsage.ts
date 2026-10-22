import { useEffect, useRef, useState } from "react";
import { readUsageLimits, usageWarnings, type UsageLimits, type UsageWarningLevels } from "../../integrations/usage.js";

export function useUsage() {
  const [usageLimits, setUsageLimits] = useState<UsageLimits>();
  const [usageError, setUsageError] = useState<string>();
  const [usageWarning, setUsageWarning] = useState<string>();
  const usageRequestPending = useRef(false);
  const usageWarningLevels = useRef<UsageWarningLevels>({});
  const usageMounted = useRef(false);
  const refreshUsage = () => {
    if (usageRequestPending.current) return;
    usageRequestPending.current = true;
    void readUsageLimits()
      .then(limits => {
        if (!usageMounted.current) return;
        if (!limits) { setUsageError("Usage unavailable"); return; }
        setUsageLimits(limits);
        setUsageError(undefined);
        const warnings = usageWarnings(limits, usageWarningLevels.current);
        usageWarningLevels.current = warnings.levels;
        if (warnings.messages.length > 0) {
          setUsageWarning(warnings.messages[0]);
        } else if (!warnings.levels["5h"] && !warnings.levels["7d"]) {
          setUsageWarning(undefined);
        }
      })
      .catch(() => { if (usageMounted.current) setUsageError("Usage unavailable"); })
      .finally(() => { usageRequestPending.current = false; });
  };
  useEffect(() => {
    usageMounted.current = true;
    refreshUsage();
    const timer = setInterval(refreshUsage, 30_000);
    return () => {
      usageMounted.current = false;
      clearInterval(timer);
    };
  }, []);
  return { usageLimits, usageError, usageWarning, refreshUsage };
}
