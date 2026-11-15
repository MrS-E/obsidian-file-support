import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "fflate";
import type { ArchiveCompressionFormat } from "../src/archives/types";

export interface TarTestEntry {
  path: string;
  content?: string | Uint8Array;
  type?: "0" | "5" | "1" | "2" | "L" | "K" | "x" | "g";
  mode?: number;
  mtime?: number;
  linkTarget?: string;
  useGnuLongName?: boolean;
  usePax?: boolean;
  paxProps?: Record<string, string>;
  rawTypeflag?: string;
  customHeaderSize?: number;
}

export const TAR_BLOCK_SIZE = 512;

export function padToBlock(size: number): number {
  return (TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
}

export function writeString(buf: Uint8Array, offset: number, length: number, str: string): void {
  const enc = new TextEncoder().encode(str);
  buf.set(enc.subarray(0, length), offset);
}

export function writeOctal(buf: Uint8Array, offset: number, length: number, val: number): void {
  const octal = val.toString(8).padStart(length - 1, "0") + " ";
  writeString(buf, offset, length, octal);
}

export function calculateChecksum(header: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  return sum;
}

export function createPaxPayload(props: Record<string, string>): Uint8Array {
  let result = "";
  for (const [key, value] of Object.entries(props)) {
    // Length includes the length digits themselves, space, key, '=', value, and newline '\n'
    const recordWithoutLen = ` ${key}=${value}\n`;
    let len = recordWithoutLen.length + 2;
    while (true) {
      const lenStr = len.toString();
      const actualLen = lenStr.length + recordWithoutLen.length;
      if (actualLen === len) break;
      len = actualLen;
    }
    result += `${len}${recordWithoutLen}`;
  }
  return new TextEncoder().encode(result);
}

export interface BuildSyntheticTarOptions {
  omitEndOfArchive?: boolean;
  onlyOneZeroBlock?: boolean;
}

/**
 * Builds a synthetically constructed TAR archive buffer.
 */
export function buildSyntheticTar(
  entries: TarTestEntry[],
  options: BuildSyntheticTarOptions = {}
): Uint8Array {
  const blocks: Uint8Array[] = [];

  for (const entry of entries) {
    const rawContent =
      entry.content instanceof Uint8Array
        ? entry.content
        : new TextEncoder().encode(entry.content ?? "");
    const size = entry.type === "5" ? 0 : rawContent.byteLength;
    const headerSize = entry.customHeaderSize !== undefined ? entry.customHeaderSize : size;
    const path = entry.path;
    const isDir = entry.type === "5" || path.endsWith("/");
    const typeflag = entry.rawTypeflag ?? entry.type ?? (isDir ? "5" : "0");

    // GNU Long Name record
    if (entry.useGnuLongName || (path.length > 100 && !entry.usePax && !entry.paxProps)) {
      const longNameBytes = new TextEncoder().encode(path + "\0");
      const gnuHeader = new Uint8Array(TAR_BLOCK_SIZE);
      writeString(gnuHeader, 0, 100, "././@LongLink");
      writeOctal(gnuHeader, 100, 8, 0o644);
      writeOctal(gnuHeader, 108, 8, 0);
      writeOctal(gnuHeader, 116, 8, 0);
      writeOctal(gnuHeader, 124, 12, longNameBytes.byteLength);
      writeOctal(gnuHeader, 136, 12, Math.floor(Date.now() / 1000));
      writeString(gnuHeader, 156, 1, "L");
      writeString(gnuHeader, 257, 6, "ustar  ");
      const chk = calculateChecksum(gnuHeader);
      writeOctal(gnuHeader, 148, 8, chk);
      blocks.push(gnuHeader);
      blocks.push(longNameBytes);
      const pad = padToBlock(longNameBytes.byteLength);
      if (pad > 0) blocks.push(new Uint8Array(pad));
    }

    // PAX extended header
    if (entry.usePax || entry.paxProps || (path.length > 100 && !entry.useGnuLongName)) {
      const paxProps: Record<string, string> = { path, ...(entry.paxProps ?? {}) };
      if (entry.linkTarget && !paxProps.linkpath) paxProps.linkpath = entry.linkTarget;
      if (entry.mtime && !paxProps.mtime) paxProps.mtime = (entry.mtime / 1000).toString();
      const paxPayload = createPaxPayload(paxProps);

      const paxHeader = new Uint8Array(TAR_BLOCK_SIZE);
      writeString(paxHeader, 0, 100, "PaxHeader/file");
      writeOctal(paxHeader, 100, 8, 0o644);
      writeOctal(paxHeader, 108, 8, 0);
      writeOctal(paxHeader, 116, 8, 0);
      writeOctal(paxHeader, 124, 12, paxPayload.byteLength);
      writeOctal(paxHeader, 136, 12, Math.floor(Date.now() / 1000));
      writeString(paxHeader, 156, 1, "x");
      writeString(paxHeader, 257, 6, "ustar\0");
      writeString(paxHeader, 263, 2, "00");
      const chk = calculateChecksum(paxHeader);
      writeOctal(paxHeader, 148, 8, chk);
      blocks.push(paxHeader);
      blocks.push(paxPayload);
      const pad = padToBlock(paxPayload.byteLength);
      if (pad > 0) blocks.push(new Uint8Array(pad));
    }

    // Main header
    const header = new Uint8Array(TAR_BLOCK_SIZE);
    const shortName = path.length <= 100 ? path : path.slice(0, 100);
    writeString(header, 0, 100, shortName);
    writeOctal(header, 100, 8, entry.mode ?? (isDir ? 0o755 : 0o644));
    writeOctal(header, 108, 8, 1000);
    writeOctal(header, 116, 8, 1000);
    writeOctal(header, 124, 12, headerSize);
    writeOctal(header, 136, 12, Math.floor((entry.mtime ?? 1700000000000) / 1000));
    writeString(header, 156, 1, typeflag);
    if (entry.linkTarget) {
      writeString(header, 157, 100, entry.linkTarget);
    }
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    writeString(header, 265, 32, "testuser");
    writeString(header, 297, 32, "testgroup");

    const checksum = calculateChecksum(header);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header);

    if (size > 0) {
      blocks.push(rawContent);
      const pad = padToBlock(size);
      if (pad > 0) {
        blocks.push(new Uint8Array(pad));
      }
    }
  }

  // End of archive marker
  if (!options.omitEndOfArchive) {
    blocks.push(new Uint8Array(TAR_BLOCK_SIZE));
    if (!options.onlyOneZeroBlock) {
      blocks.push(new Uint8Array(TAR_BLOCK_SIZE));
    }
  }

  const totalLength = blocks.reduce((acc, b) => acc + b.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const block of blocks) {
    result.set(block, offset);
    offset += block.byteLength;
  }
  return result;
}

/**
 * Compresses a byte buffer using system tools or fflate.
 */
export function compressData(data: Uint8Array, format: ArchiveCompressionFormat): Uint8Array {
  if (format === "plain") {
    return data;
  }

  if (format === "gzip") {
    return gzipSync(data);
  }

  const tmpIn = join(tmpdir(), `test_tar_in_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);
  const tmpOut = join(tmpdir(), `test_tar_out_${Date.now()}_${Math.random().toString(36).slice(2)}.bin`);

  try {
    writeFileSync(tmpIn, data);
    switch (format) {
      case "bzip2":
        execSync(`bzip2 -c "${tmpIn}" > "${tmpOut}"`);
        break;
      case "xz":
        execSync(`xz -c "${tmpIn}" > "${tmpOut}"`);
        break;
      case "zstd":
        execSync(`zstd -c "${tmpIn}" > "${tmpOut}"`);
        break;
    }
    const result = readFileSync(tmpOut);
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
  } finally {
    try {
      unlinkSync(tmpIn);
    } catch {}
    try {
      unlinkSync(tmpOut);
    } catch {}
  }
}
