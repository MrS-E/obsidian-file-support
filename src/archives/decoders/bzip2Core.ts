import { ArchiveParseError } from "../types";

const BITMASK = [0, 0x01, 0x03, 0x07, 0x0f, 0x1f, 0x3f, 0x7f, 0xff];

export const BZIP2_CRC32_TABLE: Uint32Array = new Uint32Array([
  0x00000000, 0x04c11db7, 0x09823b6e, 0x0d4326d9, 0x130476dc, 0x17c56b6b, 0x1a864db2, 0x1e475005,
  0x2608edb8, 0x22c9f00f, 0x2f8ad6d6, 0x2b4bcb61, 0x350c9b64, 0x31cd86d3, 0x3c8ea00a, 0x384fbdbd,
  0x4c11db70, 0x48d0c6c7, 0x4593e01e, 0x4152fda9, 0x5f15adac, 0x5bd4b01b, 0x569796c2, 0x52568b75,
  0x6a1936c8, 0x6ed82b7f, 0x639b0da6, 0x675a1011, 0x791d4014, 0x7ddc5da3, 0x709f7b7a, 0x745e66cd,
  0x9823b6e0, 0x9ce2ab57, 0x91a18d8e, 0x95609039, 0x8b27c03c, 0x8fe6dd8b, 0x82a5fb52, 0x8664e6e5,
  0xbe2b5b58, 0xbaea46ef, 0xb7a96036, 0xb3687d81, 0xad2f2d84, 0xa9ee3033, 0xa4ad16ea, 0xa06c0b5d,
  0xd4326d90, 0xd0f37027, 0xddb056fe, 0xd9714b49, 0xc7361b4c, 0xc3f706fb, 0xceb42022, 0xca753d95,
  0xf23a8028, 0xf6fb9d9f, 0xfbb8bb46, 0xff79a6f1, 0xe13ef6f4, 0xe5ffeb43, 0xe8bccd9a, 0xec7dd02d,
  0x34867077, 0x30476dc0, 0x3d044b19, 0x39c556ae, 0x278206ab, 0x23431b1c, 0x2e003dc5, 0x2ac12072,
  0x128e9dcf, 0x164f8078, 0x1b0ca6a1, 0x1fcdbb16, 0x018aeb13, 0x054bf6a4, 0x0808d07d, 0x0cc9cdca,
  0x7897ab07, 0x7c56b6b0, 0x71159069, 0x75d48dde, 0x6b93dddb, 0x6f52c06c, 0x6211e6b5, 0x66d0fb02,
  0x5e9f46bf, 0x5a5e5b08, 0x571d7dd1, 0x53dc6066, 0x4d9b3063, 0x495a2dd4, 0x44190b0d, 0x40d816ba,
  0xaca5c697, 0xa864db20, 0xa527fdf9, 0xa1e6e04e, 0xbfa1b04b, 0xbb60adfc, 0xb6238b25, 0xb2e29692,
  0x8aad2b2f, 0x8e6c3698, 0x832f1041, 0x87ee0df6, 0x99a95df3, 0x9d684044, 0x902b669d, 0x94ea7b2a,
  0xe0b41de7, 0xe4750050, 0xe9362689, 0xedf73b3e, 0xf3b06b3b, 0xf771768c, 0xfa325055, 0xfef34de2,
  0xc6bcf05f, 0xc27dede8, 0xcf3ecb31, 0xcbffd686, 0xd5b88683, 0xd1799b34, 0xdc3abded, 0xd8fba05a,
  0x690ce0ee, 0x6dcdfd59, 0x608edb80, 0x644fc637, 0x7a089632, 0x7ec98b85, 0x738aad5c, 0x774bb0eb,
  0x4f040d56, 0x4bc510e1, 0x46863638, 0x42472b8f, 0x5c007b8a, 0x58c1663d, 0x558240e4, 0x51435d53,
  0x251d3b9e, 0x21dc2629, 0x2c9f00f0, 0x285e1d47, 0x36194d42, 0x32d850f5, 0x3f9b762c, 0x3b5a6b9b,
  0x0315d626, 0x07d4cb91, 0x0a97ed48, 0x0e56f0ff, 0x1011a0fa, 0x14d0bd4d, 0x19939b94, 0x1d528623,
  0xf12f560e, 0xf5ee4bb9, 0xf8ad6d60, 0xfc6c70d7, 0xe22b20d2, 0xe6ea3d65, 0xeba91bbc, 0xef68060b,
  0xd727bbb6, 0xd3e6a601, 0xdea580d8, 0xda649d6f, 0xc423cd6a, 0xc0e2d0dd, 0xcda1f604, 0xc960ebb3,
  0xbd3e8d7e, 0xb9ff90c9, 0xb4bcb610, 0xb07daba7, 0xae3afba2, 0xaafbe615, 0xa7b8c0cc, 0xa379dd7b,
  0x9b3660c6, 0x9ff77d71, 0x92b45ba8, 0x9675461f, 0x8832161a, 0x8cf30bad, 0x81b02d74, 0x857130c3,
  0x5d8a9099, 0x594b8d2e, 0x5408abf7, 0x50c9b640, 0x4e8ee645, 0x4a4ffbf2, 0x470cdd2b, 0x43cdc09c,
  0x7b827d21, 0x7f436096, 0x7200464f, 0x76c15bf8, 0x68860bfd, 0x6c47164a, 0x61043093, 0x65c52d24,
  0x119b4be9, 0x155a565e, 0x18197087, 0x1cd86d30, 0x029f3d35, 0x065e2082, 0x0b1d065b, 0x0fdc1bec,
  0x3793a651, 0x3352bbe6, 0x3e119d3f, 0x3ad08088, 0x2497d08d, 0x2056cd3a, 0x2d15ebe3, 0x29d4f654,
  0xc5a92679, 0xc1683bce, 0xcc2b1d17, 0xc8ea00a0, 0xd6ad50a5, 0xd26c4d12, 0xdf2f6bcb, 0xdbee767c,
  0xe3a1cbc1, 0xe760d676, 0xea23f0af, 0xeee2ed18, 0xf0a5bd1d, 0xf464a0aa, 0xf9278673, 0xfde69bc4,
  0x89b8fd09, 0x8d79e0be, 0x803ac667, 0x84fbdbd0, 0x9abc8bd5, 0x9e7d9662, 0x933eb0bb, 0x97ffad0c,
  0xafb010b1, 0xab710d06, 0xa6322bdf, 0xa2f33668, 0xbcb4666d, 0xb8757bda, 0xb5365d03, 0xb1f740b4,
]);

export interface BitReader {
  (n: number | null): number;
  bytesRead: number;
}

/**
 * Creates a bit-level reader from a buffer source function.
 */
export function createBitReader(nextBuffer: () => Uint8Array | null | undefined): BitReader {
  let bit = 0;
  let byteIndex = 0;
  let currentChunk: Uint8Array | null = nextBuffer() ?? null;

  const reader = function (n: number | null): number {
    if (n === null && bit !== 0) {
      // align to byte boundary
      bit = 0;
      byteIndex++;
      return 0;
    }
    if (n === null) return 0;

    let result = 0;
    let bitsNeeded = n;

    while (bitsNeeded > 0) {
      while (!currentChunk || byteIndex >= currentChunk.length) {
        byteIndex = 0;
        currentChunk = nextBuffer() ?? null;
        if (!currentChunk) {
          throw new ArchiveParseError("Unexpected end of bzip2 data", "DECODER_ERROR");
        }
      }

      const left = 8 - bit;
      if (bit === 0 && bitsNeeded > 0) {
        reader.bytesRead++;
      }

      if (bitsNeeded >= left) {
        result = (result << left) | (BITMASK[left] & currentChunk[byteIndex++]);
        bit = 0;
        bitsNeeded -= left;
      } else {
        result =
          (result << bitsNeeded) |
          ((currentChunk[byteIndex] & (BITMASK[bitsNeeded] << (8 - bitsNeeded - bit))) >>
            (8 - bitsNeeded - bit));
        bit += bitsNeeded;
        bitsNeeded = 0;
      }
    }
    return result;
  };

  reader.bytesRead = 0;
  return reader;
}

/**
 * Reads and validates the bzip2 stream header. Returns block size multiplier (1..9).
 */
export function readBzip2Header(reader: BitReader): number {
  const magic1 = reader(8);
  const magic2 = reader(8);
  if (magic1 !== 0x42 || magic2 !== 0x5a) {
    // "BZ"
    throw new ArchiveParseError("Invalid bzip2 magic header", "DECODER_ERROR");
  }

  const version = reader(8);
  if (version !== 0x68) {
    // 'h'
    throw new ArchiveParseError("Invalid bzip2 version", "DECODER_ERROR");
  }

  const level = reader(8);
  if (level < 0x31 || level > 0x39) {
    // '1'..'9'
    throw new ArchiveParseError("Invalid bzip2 block size header", "DECODER_ERROR");
  }

  return level - 0x30;
}

/**
 * Decompresses one bzip2 block.
 * Calls `onByte` for each decoded uncompressed byte.
 * Returns updated streamCRC, or null if end-of-stream was reached.
 */
export function decompressBzip2Block(
  reader: BitReader,
  onByte: (byte: number) => void,
  buf: Int32Array,
  bufsize: number,
  streamCRC: number
): number | null {
  // Read 48-bit magic (PI: 0x314159265359 or SQRT(PI): 0x177245385090)
  const magicUpper = (reader(16) << 8) | reader(8);
  const magicLower = (reader(16) << 8) | reader(8);

  // Check end of stream magic (0x177245385090)
  if (magicUpper === 0x177245 && magicLower === 0x385090) {
    const finalCRC = ((reader(16) << 16) | reader(16)) >>> 0;
    reader(null); // align byte boundary
    if ((streamCRC >>> 0) !== finalCRC) {
      throw new ArchiveParseError("bzip2 stream CRC mismatch", "DECODER_ERROR");
    }
    return null;
  }

  // Check block sync magic (0x314159265359)
  if (magicUpper !== 0x314159 || magicLower !== 0x265359) {
    throw new ArchiveParseError("Bad bzip2 block sync magic", "DECODER_ERROR");
  }

  const crcblock = ((reader(16) << 16) | reader(16)) >>> 0;
  const randomized = reader(1);
  if (randomized) {
    throw new ArchiveParseError("Unsupported randomized bzip2 block", "DECODER_ERROR");
  }

  let origPtr = (reader(8) << 16) | reader(16);

  // Read mapping table
  const inUse16 = reader(16);
  const symToByte = new Uint8Array(256);
  let symTotal = 0;

  for (let i = 0; i < 16; i++) {
    if (inUse16 & (1 << (15 - i))) {
      const inUse = reader(16);
      for (let j = 0; j < 16; j++) {
        if (inUse & (1 << (15 - j))) {
          symToByte[symTotal++] = (i << 4) | j;
        }
      }
    }
  }

  const symTotalEos = symTotal + 2;
  const groups = reader(3);
  if (groups < 2 || groups > 6) {
    throw new ArchiveParseError("Invalid bzip2 group count", "DECODER_ERROR");
  }

  const selectors = reader(15);
  if (selectors < 1 || selectors > 18002) {
    throw new ArchiveParseError("Invalid bzip2 selector count", "DECODER_ERROR");
  }

  const mtfSymbols = new Uint8Array(groups);
  for (let i = 0; i < groups; i++) {
    mtfSymbols[i] = i;
  }

  const selectorList = new Uint8Array(selectors);
  for (let i = 0; i < selectors; i++) {
    let count = 0;
    while (reader(1)) {
      count++;
      if (count >= groups) {
        throw new ArchiveParseError("bzip2 selector out of bounds", "DECODER_ERROR");
      }
    }
    const val = mtfSymbols[count];
    for (let j = count; j > 0; j--) {
      mtfSymbols[j] = mtfSymbols[j - 1];
    }
    mtfSymbols[0] = val;
    selectorList[i] = val;
  }

  // Read Huffman tables
  const limit: Int32Array[] = [];
  const base: Int32Array[] = [];
  const perm: Int32Array[] = [];

  for (let t = 0; t < groups; t++) {
    let len = reader(5);
    const lengthTable = new Uint8Array(symTotalEos);
    for (let i = 0; i < symTotalEos; i++) {
      while (reader(1)) {
        len += 1 - 2 * reader(1);
      }
      if (len < 1 || len > 20) {
        throw new ArchiveParseError("bzip2 Huffman code length out of bounds", "DECODER_ERROR");
      }
      lengthTable[i] = len;
    }

    let minLen = 32;
    let maxLen = 0;
    for (let i = 0; i < symTotalEos; i++) {
      const l = lengthTable[i];
      if (l > maxLen) maxLen = l;
      if (l < minLen) minLen = l;
    }

    const tLimit = new Int32Array(maxLen + 2);
    const tBase = new Int32Array(maxLen + 2);
    const tPerm = new Int32Array(symTotalEos);

    let pp = 0;
    for (let i = minLen; i <= maxLen; i++) {
      for (let j = 0; j < symTotalEos; j++) {
        if (lengthTable[j] === i) {
          tPerm[pp++] = j;
        }
      }
    }

    for (let i = 0; i < maxLen + 2; i++) {
      tBase[i] = 0;
      tLimit[i] = 0;
    }

    for (let i = 0; i < symTotalEos; i++) {
      tBase[lengthTable[i] + 1]++;
    }
    for (let i = 1; i < maxLen + 2; i++) {
      tBase[i] += tBase[i - 1];
    }

    let code = 0;
    for (let i = minLen; i <= maxLen; i++) {
      const baseVal = code;
      code += tBase[i + 1] - tBase[i];
      tBase[i] = baseVal - tBase[i];
      tLimit[i] = code - 1;
      code <<= 1;
    }

    limit.push(tLimit);
    base.push(tBase);
    perm.push(tPerm);
  }

  // Decode MTF stream
  const byteCount = new Int32Array(256);
  const symIndex = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    symIndex[i] = i;
  }

  let dbufCount = 0;
  let selectorIdx = 0;
  let groupIdx = selectorList[0];
  let groupLimit = limit[groupIdx];
  let groupBase = base[groupIdx];
  let groupPerm = perm[groupIdx];
  let countTillChange = 50;

  let run = 0;
  let runPos = 0;

  while (true) {
    if (--countTillChange <= 0) {
      if (selectorIdx >= selectors) {
        throw new ArchiveParseError("bzip2 selector index exceeded", "DECODER_ERROR");
      }
      groupIdx = selectorList[selectorIdx++];
      groupLimit = limit[groupIdx];
      groupBase = base[groupIdx];
      groupPerm = perm[groupIdx];
      countTillChange = 50;
    }

    let code = 0;
    let len = 0;
    while (true) {
      code = (code << 1) | reader(1);
      len++;
      if (len > 20) {
        throw new ArchiveParseError("bzip2 Huffman symbol length exceeded", "DECODER_ERROR");
      }
      if (code <= groupLimit[len]) {
        break;
      }
    }

    const nextSym = groupPerm[code - groupBase[len]];
    if (nextSym < 0 || nextSym >= symTotalEos) {
      throw new ArchiveParseError("bzip2 decoded symbol out of range", "DECODER_ERROR");
    }

    if (nextSym === 0 || nextSym === 1) {
      if (runPos === 0) {
        runPos = 1;
        run = 0;
      }
      run += (nextSym + 1) * runPos;
      runPos <<= 1;
      continue;
    }

    if (runPos !== 0) {
      runPos = 0;
      if (dbufCount + run > bufsize) {
        throw new ArchiveParseError("bzip2 buffer overflow during run expansion", "DECODER_ERROR");
      }
      const uc = symToByte[symIndex[0]];
      byteCount[uc] += run;
      while (run-- > 0) {
        buf[dbufCount++] = uc;
      }
      run = 0;
    }

    if (nextSym === symTotal + 1) {
      // End of block
      break;
    }

    if (dbufCount >= bufsize) {
      throw new ArchiveParseError("bzip2 buffer overflow", "DECODER_ERROR");
    }

    const mtfIndex = nextSym - 1;
    const b = symToByte[symIndex[mtfIndex]];
    byteCount[b]++;
    buf[dbufCount++] = b;

    const tmp = symIndex[mtfIndex];
    for (let j = mtfIndex; j > 0; j--) {
      symIndex[j] = symIndex[j - 1];
    }
    symIndex[0] = tmp;
  }

  if (origPtr < 0 || origPtr >= dbufCount) {
    throw new ArchiveParseError("Invalid bzip2 origPtr pointer", "DECODER_ERROR");
  }

  // Setup inverse BWT table
  const unwrapBase = new Int32Array(256);
  let total = 0;
  for (let i = 0; i < 256; i++) {
    unwrapBase[i] = total;
    total += byteCount[i];
  }

  const tt = new Int32Array(dbufCount);
  for (let i = 0; i < dbufCount; i++) {
    const uc = buf[i] & 0xff;
    tt[unwrapBase[uc]] = (i << 8) | uc;
    unwrapBase[uc]++;
  }

  // Inverse BWT & RLE decompression output
  let pos = origPtr;
  let previous = -1;
  run = 0;
  let crc = 0xffffffff;
  let count = dbufCount;

  while (count > 0) {
    count--;
    const val = tt[pos];
    const b = val & 0xff;
    pos = val >> 8;

    if (run === 4) {
      const copies = b;
      for (let i = 0; i < copies; i++) {
        crc = ((crc << 8) ^ BZIP2_CRC32_TABLE[((crc >>> 24) ^ previous) & 0xff]) >>> 0;
        onByte(previous);
      }
      run = 0;
      previous = -1;
    } else {
      crc = ((crc << 8) ^ BZIP2_CRC32_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
      onByte(b);
      if (b === previous) {
        run++;
      } else {
        run = 1;
        previous = b;
      }
    }
  }

  crc = (crc ^ 0xffffffff) >>> 0;
  if ((crc | 0) !== (crcblock | 0)) {
    throw new ArchiveParseError("bzip2 block CRC mismatch", "DECODER_ERROR");
  }

  streamCRC = ((crc ^ ((streamCRC << 1) | (streamCRC >>> 31))) & 0xffffffff) >>> 0;
  return streamCRC;
}
