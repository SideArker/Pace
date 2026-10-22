import { useEffect, useRef, useState } from "react";
import { useStdout } from "ink";

export function useTerminalDimensions(onViewportChange: () => void) {
  const { stdout } = useStdout();
  const [terminalDimensions, setTerminalDimensions] = useState(() => ({
    columns: stdout?.columns ?? 80,
    rows: stdout?.rows ?? 24,
  }));
  const lastTerminalDimensions = useRef(terminalDimensions);

  useEffect(() => {
    const stream = stdout ?? process.stdout;
    if (!stream) return;
    const onResize = () => {
      const next = {
        columns: stream.columns ?? 80,
        rows: stream.rows ?? 24,
      };
      if (next.columns === lastTerminalDimensions.current.columns && next.rows === lastTerminalDimensions.current.rows) return;
      lastTerminalDimensions.current = next;
      // Ink has already redrawn using the old layout. Clear that frame before
      // remounting Static at the new width so it cannot remain in scrollback.
      onViewportChange();
      setTerminalDimensions(next);
    };
    stream.on?.("resize", onResize);
    return () => {
      stream.off?.("resize", onResize);
    };
  }, [stdout]);

  return terminalDimensions;
}
