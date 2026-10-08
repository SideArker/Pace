import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 21 * 1024 * 1024;
const CLIPBOARD_TIMEOUT_MS = 5000;

async function clipboardBytes(command: string, args: string[]): Promise<Buffer | undefined> {
  try {
    const { stdout } = await run(command, args, {
      encoding: "buffer",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: CLIPBOARD_TIMEOUT_MS,
    });
    return stdout.length ? stdout : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error("Clipboard image exceeds 15 MB.");
    return undefined;
  }
}

export function imageExtension(bytes: Buffer): "png" | "jpg" | "gif" | "webp" | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return "jpg";
  if (bytes.subarray(0, 6).toString("ascii") === "GIF87a" || bytes.subarray(0, 6).toString("ascii") === "GIF89a") return "gif";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return undefined;
}

async function readClipboardImage(): Promise<Buffer | undefined> {
  if (process.env.WSL_DISTRO_NAME) {
    const script = "Add-Type -AssemblyName System.Windows.Forms; $image = [System.Windows.Forms.Clipboard]::GetImage(); if ($image) { $stream = New-Object System.IO.MemoryStream; $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png); [Console]::Write([Convert]::ToBase64String($stream.ToArray())) }";
    const encoded = await clipboardBytes("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-Command", script]);
    if (encoded) return Buffer.from(encoded.toString("utf8").trim(), "base64");
  }
  if (process.platform === "darwin") return clipboardBytes("pngpaste", ["-"]);
  for (const format of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
    if (process.env.WAYLAND_DISPLAY) {
      const bytes = await clipboardBytes("wl-paste", ["--no-newline", "--type", format]);
      if (bytes && imageExtension(bytes)) return bytes;
    }
    const bytes = await clipboardBytes("xclip", ["-selection", "clipboard", "-t", format, "-o"]);
    if (bytes && imageExtension(bytes)) return bytes;
  }
  return undefined;
}

export async function saveClipboardImage(targetFolder: string): Promise<string | undefined> {
  const bytes = await readClipboardImage();
  if (!bytes) return undefined;
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Clipboard image exceeds 15 MB.");
  const extension = imageExtension(bytes);
  if (!extension) throw new Error("Clipboard contains an unsupported image format.");
  await mkdir(targetFolder, { recursive: true });
  const path = join(targetFolder, `${randomUUID()}.${extension}`);
  await writeFile(path, bytes, { flag: "wx" });
  return path;
}
