import { Text } from "ink";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type MarkdownRun = { text: string; color?: string; bold?: boolean; italic?: boolean; underline?: boolean; dimColor?: boolean; code?: boolean; url?: string };

function terminalLinkTarget(destination: string): string | undefined {
  const href = destination.startsWith("<") && destination.endsWith(">") ? destination.slice(1, -1) : destination;
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
    try {
      const url = new URL(href);
      return ["http:", "https:", "mailto:", "file:"].includes(url.protocol) ? url.href : undefined;
    } catch { return undefined; }
  }
  return pathToFileURL(resolve(process.cwd(), href)).href;
}

function terminalLink(text: string, destination: string): string {
  const target = terminalLinkTarget(destination);
  return target ? `\u001b]8;;${target}\u001b\\${text}\u001b]8;;\u001b\\` : text;
}

function markdownRuns(source: string): MarkdownRun[] {
  const runs: MarkdownRun[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\((?:<[^>]+>|(?:[^()]|\([^()]*\))+?)\))/g;
  let offset = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > offset) runs.push({ text: source.slice(offset, index) });
    const token = match[0];
    if (token.startsWith("`")) runs.push({ text: token.slice(1, -1), code: true, color: "#FBBF24" });
    else if (token.startsWith("**") || token.startsWith("__")) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith("~~")) runs.push({ text: token.slice(2, -2), dimColor: true });
    else if (token.startsWith("*") || token.startsWith("_")) runs.push({ text: token.slice(1, -1), italic: true });
    else {
      const link = /^\[([^\]]+)\]\((.+)\)$/.exec(token)!;
      runs.push({ text: `${link[1]} (${link[2]})`, color: "#38BDF8", underline: true, url: link[2] });
    }
    offset = index + token.length;
  }
  if (offset < source.length) runs.push({ text: source.slice(offset) });
  return runs.length ? runs : [{ text: source }];
}

export function MarkdownText({ source, color }: { source: string; color?: string }) {
  const fenced = source.startsWith("```");
  if (fenced) {
    const code = source.replace(/^```[^\n]*\n?/, "").replace(/\n?```\s*$/, "");
    return <Text color="#FBBF24">{code}</Text>;
  }
  const heading = /^(#{1,6})\s+(.+)$/.exec(source);
  const list = /^(\s*)([-*+] |\d+\. )(.*)$/.exec(source);
  const quote = /^>\s?(.*)$/.exec(source);
  const body = heading?.[2] ?? list?.[3] ?? quote?.[1] ?? source;
  const prefix = heading ? "" : list ? `${list[1]}${/^\d/.test(list[2]!) ? list[2] : "• "}` : quote ? "│ " : "";
  const colorForText = heading ? "#A7F3D0" : quote ? "#94A3B8" : color;
  return <Text color={colorForText} bold={!!heading}>{prefix}{markdownRuns(body).map((run, index) => <Text key={index} color={run.color ?? colorForText} bold={run.bold} italic={run.italic} underline={run.underline} dimColor={run.dimColor}>{run.code ? <Text backgroundColor="#1E293B">{run.text}</Text> : run.url ? terminalLink(run.text, run.url) : run.text}</Text>)}</Text>;
}
