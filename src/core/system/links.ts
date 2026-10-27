import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const markdownLinkPattern = /\[([^\]]+)\]\((<[^>]+>|(?:[^()]|\([^()]*\))+?)\)/g;

export function terminalLinkTarget(destination: string, cwd = process.cwd()): string | undefined {
  const href = destination.startsWith("<") && destination.endsWith(">") ? destination.slice(1, -1) : destination;
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    try {
      const url = new URL(href);
      return ["http:", "https:", "mailto:", "file:"].includes(url.protocol) ? url.href : undefined;
    } catch { return undefined; }
  }
  return pathToFileURL(resolve(cwd, href)).href;
}

export function terminalLink(text: string, destination: string): string {
  const target = terminalLinkTarget(destination);
  return target ? `\u001b]8;;${target}\u001b\\${text}\u001b]8;;\u001b\\` : text;
}

export function markdownLinks(source: string, cwd = process.cwd()): { label: string; target: string }[] {
  // Match the rendered prose; examples in code blocks/inline code are not links.
  const prose = source.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, "").replace(/`[^`]+`/g, "");
  return [...prose.matchAll(markdownLinkPattern)].flatMap(match => {
    const target = terminalLinkTarget(match[2]!, cwd);
    return target ? [{ label: match[1]!, target }] : [];
  });
}

export function linkOpenCommand(target: string, platform = process.platform): [string, string[]] {
  const safe = terminalLinkTarget(target);
  if (!safe) throw new Error("Unsupported link destination");
  return platform === "darwin" ? ["open", [safe]]
    : platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", safe]]
    : ["xdg-open", [safe]];
}

export async function openLink(target: string): Promise<void> {
  const [command, args] = linkOpenCommand(target);
  await promisify(execFile)(command, args, { windowsHide: true });
}
