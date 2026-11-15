import { describe, expect, it } from "vitest";
import {
  extractTextPreview,
  isBinaryData,
  isPathUnsafe,
  parsePaxHeaders,
  readOctal,
  readSize,
  sanitizeArchivePath,
  scanArchive,
} from "../src/archives/tarScanner";
import {
  ArchiveAbortError,
  ArchiveError,
  ArchiveLimitError,
  ArchiveParseError,
  DEFAULT_ARCHIVE_LIMITS,
} from "../src/archives/types";
import {
  buildSyntheticTar,
  calculateChecksum,
  compressData,
  createPaxPayload,
  padToBlock,
  TAR_BLOCK_SIZE,
  writeOctal,
  writeString,
} from "./tarTestHelpers";

describe("ArchiveTarScanner", () => {
  describe("sanitizeArchivePath & isPathUnsafe", () => {
    it("normalizes path separators and strips leading slashes", () => {
      expect(sanitizeArchivePath("/usr/local/bin/run", 1000)).toBe("usr/local/bin/run");
      expect(sanitizeArchivePath("C:\\Windows\\System32\\file.dll", 1000)).toBe(
        "Windows/System32/file.dll"
      );
    });

    it("prevents directory traversal and escapes", () => {
      expect(sanitizeArchivePath("../../../etc/passwd", 1000)).toBe("etc/passwd");
      expect(sanitizeArchivePath("foo/../../bar.txt", 1000)).toBe("bar.txt");
      expect(sanitizeArchivePath("a/./b/../c/file.txt", 1000)).toBe("a/c/file.txt");
    });

    it("preserves trailing slash on directories", () => {
      expect(sanitizeArchivePath("dir/subdir/", 1000)).toBe("dir/subdir/");
    });

    it("detects unsafe traversal and absolute paths", () => {
      expect(isPathUnsafe("../../../etc/passwd")).toBe(true);
      expect(isPathUnsafe("/etc/passwd")).toBe(true);
      expect(isPathUnsafe("\\Windows\\System32")).toBe(true);
      expect(isPathUnsafe("C:\\file.txt")).toBe(true);
      expect(isPathUnsafe("foo/../bar.txt")).toBe(true);
      expect(isPathUnsafe("safe/nested/file.txt")).toBe(false);
      expect(isPathUnsafe("notes.md")).toBe(false);
    });

    it("marks isUnsafe on entries during archive scan", async () => {
      const tar = buildSyntheticTar([
        { path: "../../../etc/passwd", content: "root:x:0:0" },
        { path: "/absolute/path/note.txt", content: "abs content" },
        { path: "safe/path/file.txt", content: "safe content" },
      ]);

      const result = await scanArchive(tar, "plain");
      expect(result.entries.length).toBe(3);
      expect(result.entries[0].isUnsafe).toBe(true);
      expect(result.entries[0].path).toBe("etc/passwd");
      expect(result.entries[1].isUnsafe).toBe(true);
      expect(result.entries[1].path).toBe("absolute/path/note.txt");
      expect(result.entries[2].isUnsafe).toBeUndefined();
      expect(result.entries[2].path).toBe("safe/path/file.txt");
    });

    it("throws ArchiveLimitError when path exceeds maxNameLength", () => {
      expect(() => sanitizeArchivePath("a".repeat(50), 40)).toThrow(ArchiveLimitError);
    });
  });

  describe("readOctal & readSize", () => {
    it("reads valid octal fields with various padding", () => {
      const buf = new Uint8Array(8);
      writeOctal(buf, 0, 8, 0o644);
      expect(readOctal(buf, 0, 8)).toBe(0o644);

      const empty = new Uint8Array(8); // all 0
      expect(readOctal(empty, 0, 8)).toBe(0);

      const spaces = new Uint8Array([0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20, 0x20]);
      expect(readOctal(spaces, 0, 8)).toBe(0);
    });

    it("rejects octal fields containing non-octal characters", () => {
      const buf = new TextEncoder().encode("0000789 "); // '8' and '9' are not octal
      expect(() => readOctal(buf, 0, 8)).toThrow(ArchiveParseError);

      const letters = new TextEncoder().encode("0000abc ");
      expect(() => readOctal(letters, 0, 8)).toThrow(ArchiveParseError);
    });

    it("rejects octal fields with trailing garbage", () => {
      const buf = new TextEncoder().encode("000644\0x");
      expect(() => readOctal(buf, 0, 8)).toThrow(ArchiveParseError);
    });

    it("reads base-256 positive sizes", () => {
      const buf = new Uint8Array(12);
      buf[0] = 0x80; // High bit set, positive base-256
      buf[10] = 0x04;
      buf[11] = 0x00; // 1024
      expect(readSize(buf, 0, 12)).toBe(1024);
    });

    it("rejects base-256 negative sizes", () => {
      const buf = new Uint8Array(12);
      buf[0] = 0xff; // Negative 2's complement
      expect(() => readSize(buf, 0, 12)).toThrow(ArchiveParseError);
    });
  });

  describe("parsePaxHeaders", () => {
    it("parses valid PAX key-value records with exact boundaries", () => {
      const payload = new TextEncoder().encode(
        "27 path=long/name/test.txt\n15 size=123456\n20 mtime=1700000000\n"
      );
      const res = parsePaxHeaders(payload);
      expect(res.path).toBe("long/name/test.txt");
      expect(res.size).toBe("123456");
      expect(res.mtime).toBe("1700000000");
    });

    it("throws ArchiveLimitError when PAX payload exceeds maxMetadataBytes", () => {
      const oversizedPayload = new Uint8Array(2000);
      expect(() =>
        parsePaxHeaders(oversizedPayload, {
          ...DEFAULT_ARCHIVE_LIMITS,
          maxMetadataBytes: 1000,
        })
      ).toThrow(ArchiveLimitError);
    });
  });

  describe("scanArchive", () => {
    it("indexes standard TAR with plain format", async () => {
      const tar = buildSyntheticTar([
        { path: "dir/", type: "5", mode: 0o755 },
        { path: "dir/hello.txt", content: "Hello World", mode: 0o644 },
        { path: "symlink.txt", linkTarget: "dir/hello.txt", type: "2" },
      ]);

      const result = await scanArchive(tar, "plain");
      expect(result.isComplete).toBe(true);
      expect(result.format).toBe("plain");
      expect(result.entries.length).toBe(3);

      expect(result.entries[0]).toMatchObject({
        ordinal: 0,
        path: "dir/",
        name: "dir",
        type: "directory",
        size: 0,
      });

      expect(result.entries[1]).toMatchObject({
        ordinal: 1,
        path: "dir/hello.txt",
        name: "hello.txt",
        type: "file",
        size: 11,
      });

      expect(result.entries[2]).toMatchObject({
        ordinal: 2,
        path: "symlink.txt",
        name: "symlink.txt",
        type: "symlink",
        linkTarget: "dir/hello.txt",
      });
    });

    it("indexes gzip compressed TAR format", async () => {
      const plainTar = buildSyntheticTar([
        { path: "notes/sample.md", content: "# Sample Markdown Note\nContent goes here." },
        { path: "src/main.ts", content: "console.log('test');" },
      ]);
      const compressed = compressData(plainTar, "gzip");

      const result = await scanArchive(compressed, "gzip");
      expect(result.isComplete).toBe(true);
      expect(result.format).toBe("gzip");
      expect(result.entries.length).toBe(2);
      expect(result.entries[0].path).toBe("notes/sample.md");
      expect(result.entries[1].path).toBe("src/main.ts");
    });

    it("handles GNU long filename records ('L')", async () => {
      const longName =
        "very/deeply/nested/directory/structure/with/a/super/long/filename/that/exceeds/the/standard/one/hundred/characters/limit/document.txt";
      const tar = buildSyntheticTar([
        { path: longName, content: "GNU Long Name Content", useGnuLongName: true },
      ]);

      const result = await scanArchive(tar, "plain");
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].path).toBe(longName);
      expect(result.entries[0].name).toBe("document.txt");
    });

    it("handles PAX extended headers ('x')", async () => {
      const unicodePath = "documents/üñîçødé-tëst/日本語ファイル.txt";
      const tar = buildSyntheticTar([
        { path: unicodePath, content: "Unicode Content", usePax: true },
      ]);

      const result = await scanArchive(tar, "plain");
      expect(result.entries.length).toBe(1);
      expect(result.entries[0].path).toBe(unicodePath);
      expect(result.entries[0].name).toBe("日本語ファイル.txt");
    });

    it("handles PAX size override and preserves stream alignment", async () => {
      const bigContent = "B".repeat(1200); // 1200 bytes > 512, spans 3 blocks
      const tar = buildSyntheticTar([
        {
          path: "file1.txt",
          content: bigContent,
          customHeaderSize: 100, // USTAR header says 100, but PAX says 1200
          paxProps: { size: "1200" },
        },
        {
          path: "file2.txt",
          content: "Second file content after PAX size override",
        },
      ]);

      const result = await scanArchive(tar, "plain");
      expect(result.entries.length).toBe(2);
      expect(result.entries[0].path).toBe("file1.txt");
      expect(result.entries[0].size).toBe(1200);
      expect(result.entries[1].path).toBe("file2.txt");

      const preview2 = await extractTextPreview(tar, "plain", 1);
      expect(preview2.content).toBe("Second file content after PAX size override");
    });

    it("handles duplicate filenames with distinct stable ordinals", async () => {
      const tar = buildSyntheticTar([
        { path: "log.txt", content: "First version" },
        { path: "log.txt", content: "Second updated version" },
      ]);

      const result = await scanArchive(tar, "plain");
      expect(result.entries.length).toBe(2);
      expect(result.entries[0].ordinal).toBe(0);
      expect(result.entries[0].path).toBe("log.txt");
      expect(result.entries[1].ordinal).toBe(1);
      expect(result.entries[1].path).toBe("log.txt");
    });

    it("enforces maxEntryCount limit", async () => {
      const entries = Array.from({ length: 15 }, (_, i) => ({
        path: `file_${i}.txt`,
        content: `Content ${i}`,
      }));
      const tar = buildSyntheticTar(entries);

      await expect(
        scanArchive(tar, "plain", {
          limits: { maxEntryCount: 10 },
        })
      ).rejects.toThrow(ArchiveLimitError);
    });

    it("enforces maxEntryNameLength limit", async () => {
      const tar = buildSyntheticTar([{ path: "a".repeat(100), content: "test" }]);

      await expect(
        scanArchive(tar, "plain", {
          limits: { maxEntryNameLength: 50 },
        })
      ).rejects.toThrow(ArchiveLimitError);
    });

    it("enforces maxMetadataBytes on GNU long name without allocating huge buffers", async () => {
      // Craft a GNU long name header declaring 2 MiB size
      const header = new Uint8Array(TAR_BLOCK_SIZE);
      writeString(header, 0, 100, "././@LongLink");
      writeOctal(header, 100, 8, 0o644);
      writeOctal(header, 124, 12, 2 * 1024 * 1024); // 2 MiB
      writeString(header, 156, 1, "L");
      writeString(header, 257, 6, "ustar  ");
      const chk = calculateChecksum(header);
      writeOctal(header, 148, 8, chk);

      await expect(
        scanArchive(header, "plain", {
          limits: { maxMetadataBytes: 1024 * 1024 }, // 1 MiB limit
        })
      ).rejects.toThrow(ArchiveLimitError);
    });

    it("supports cooperative onYield during long scans", async () => {
      const entries = Array.from({ length: 250 }, (_, i) => ({
        path: `entry_${i}.txt`,
        content: `data ${i}`,
      }));
      const tar = buildSyntheticTar(entries);

      let yieldCount = 0;
      await scanArchive(tar, "plain", {
        onYield: () => {
          yieldCount++;
        },
      });

      expect(yieldCount).toBeGreaterThan(0);
    });
  });

  describe("extractTextPreview", () => {
    it("extracts UTF-8 text preview for regular file", async () => {
      const tar = buildSyntheticTar([
        { path: "file1.txt", content: "First File" },
        { path: "file2.md", content: "# Markdown Heading\n\nPreview body." },
        { path: "file3.txt", content: "Third File" },
      ]);

      const preview = await extractTextPreview(tar, "plain", 1);
      expect(preview.entry.ordinal).toBe(1);
      expect(preview.entry.path).toBe("file2.md");
      expect(preview.content).toBe("# Markdown Heading\n\nPreview body.");
      expect(preview.isBinary).toBe(false);
      expect(preview.isOversized).toBe(false);
    });

    it("distinguishes duplicate filenames by ordinal", async () => {
      const tar = buildSyntheticTar([
        { path: "duplicate.txt", content: "Version A" },
        { path: "duplicate.txt", content: "Version B" },
      ]);

      const previewA = await extractTextPreview(tar, "plain", 0);
      expect(previewA.content).toBe("Version A");

      const previewB = await extractTextPreview(tar, "plain", 1);
      expect(previewB.content).toBe("Version B");
    });

    it("detects binary content", async () => {
      const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x0d]);
      const tar = buildSyntheticTar([{ path: "image.png", content: binaryData }]);

      const preview = await extractTextPreview(tar, "plain", 0);
      expect(preview.isBinary).toBe(true);
      expect(preview.content).toBe("");
      expect(preview.errorMessage).toContain("Binary file");
    });

    it("flags oversized entries exceeding maxPreviewBytes", async () => {
      const largeContent = "x".repeat(2000);
      const tar = buildSyntheticTar([{ path: "large.txt", content: largeContent }]);

      const preview = await extractTextPreview(tar, "plain", 0, {
        maxPreviewBytes: 1000,
      });
      expect(preview.isOversized).toBe(true);
      expect(preview.content).toBe("");
      expect(preview.errorMessage).toContain("exceeds preview limit");
    });

    it("rejects non-file entries (directories, symlinks)", async () => {
      const tar = buildSyntheticTar([
        { path: "folder/", type: "5" },
        { path: "link.txt", linkTarget: "target.txt", type: "2" },
      ]);

      const dirPreview = await extractTextPreview(tar, "plain", 0);
      expect(dirPreview.errorMessage).toContain("Cannot preview directory");

      const linkPreview = await extractTextPreview(tar, "plain", 1);
      expect(linkPreview.errorMessage).toContain("Cannot preview symlink");
    });

    it("throws ArchiveError with ENTRY_NOT_FOUND when target ordinal does not exist", async () => {
      const tar = buildSyntheticTar([{ path: "file.txt", content: "test" }]);

      await expect(extractTextPreview(tar, "plain", 99)).rejects.toThrow(
        expect.objectContaining({ code: "ENTRY_NOT_FOUND" })
      );
    });
  });

  describe("malformed input, truncation and error handling", () => {
    it("rejects TAR headers with bad checksums", async () => {
      const tar = buildSyntheticTar([{ path: "test.txt", content: "data" }]);
      // Corrupt checksum field in header block (bytes 148..155)
      tar[148] = 0x39;
      tar[149] = 0x39;

      await expect(scanArchive(tar, "plain")).rejects.toThrow(ArchiveParseError);
    });

    it("rejects truncated TAR headers", async () => {
      const truncated = new Uint8Array(200); // Less than 512-byte header

      await expect(scanArchive(truncated, "plain")).rejects.toThrow(ArchiveParseError);
    });

    it("rejects truncated payload data", async () => {
      const tar = buildSyntheticTar([{ path: "test.txt", content: "A".repeat(1000) }]);
      // Slices off the middle of the payload
      const truncated = tar.subarray(0, 600);

      await expect(scanArchive(truncated, "plain")).rejects.toThrow(ArchiveParseError);
    });

    it("rejects TAR archives missing end-of-archive marker", async () => {
      // Archive with valid entry but no zero blocks at the end
      const tarNoEoa = buildSyntheticTar(
        [{ path: "test.txt", content: "Some content" }],
        { omitEndOfArchive: true }
      );

      await expect(scanArchive(tarNoEoa, "plain")).rejects.toThrow(ArchiveParseError);
    });

    it("rejects TAR archives with only one zero block at EOF", async () => {
      const tarOneBlock = buildSyntheticTar(
        [{ path: "test.txt", content: "Some content" }],
        { onlyOneZeroBlock: true }
      );

      await expect(scanArchive(tarOneBlock, "plain")).rejects.toThrow(ArchiveParseError);
    });

    it("drains decoder after end marker and verifies truncated compressed stream", async () => {
      const plainTar = buildSyntheticTar([{ path: "test.txt", content: "Hello" }]);
      const compressed = compressData(plainTar, "gzip");

      // Cut off stream so that deflate stream is incomplete
      const truncatedStream = compressed.subarray(0, compressed.length - 15);

      await expect(scanArchive(truncatedStream, "gzip")).rejects.toThrow(
        expect.objectContaining({ code: "DECODER_ERROR" })
      );
    });

    it("surfaces TRUNCATED_ARCHIVE during preview on truncated archive", async () => {
      const plainTar = buildSyntheticTar([{ path: "test.txt", content: "Hello" }]);
      // Truncate after header but before complete payload
      const truncated = plainTar.subarray(0, 520);

      await expect(extractTextPreview(truncated, "plain", 0)).rejects.toThrow(
        expect.objectContaining({ code: "TRUNCATED_ARCHIVE" })
      );
    });

    it("cancels operation via AbortSignal", async () => {
      const tar = buildSyntheticTar([{ path: "test.txt", content: "A".repeat(100) }]);
      const controller = new AbortController();
      controller.abort();

      await expect(
        scanArchive(tar, "plain", { signal: controller.signal })
      ).rejects.toThrow(ArchiveAbortError);

      await expect(
        extractTextPreview(tar, "plain", 0, { signal: controller.signal })
      ).rejects.toThrow(ArchiveAbortError);
    });
  });
});
