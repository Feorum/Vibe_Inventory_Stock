// Dependency-free, deterministic PNG icons. The cup fits inside the maskable safe zone.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, bytes])));
  return Buffer.concat([length, type, bytes, checksum]);
}
function png(size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const body =
        u > 0.28 &&
        u < 0.65 &&
        v > 0.4 &&
        v < 0.66 &&
        (v < 0.56 || ((u - 0.465) / 0.185) ** 2 + ((v - 0.56) / 0.12) ** 2 < 1);
      const handle =
        Math.abs(Math.hypot((u - 0.655) / 1, (v - 0.495) / 1) - 0.075) <
          0.018 && u > 0.65;
      const saucer = v > 0.715 && v < 0.745 && u > 0.25 && u < 0.74;
      const steam = [0.36, 0.465, 0.57].some(
        (center) => Math.abs(u - center) < 0.012 && v > 0.265 && v < 0.335,
      );
      const color =
        body || handle || saucer || steam ? [214, 229, 169] : [41, 61, 50];
      const offset = y * (size * 3 + 1) + 1 + x * 3;
      raw.set(color, offset);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const [filename, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["maskable-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(
    fileURLToPath(new URL(`../public/icons/${filename}`, import.meta.url)),
    png(size),
  );
}
