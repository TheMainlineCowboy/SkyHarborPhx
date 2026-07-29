import fs from "node:fs";
import path from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg) throw new Error("Usage: node scripts/inspect-fsx-placement-bgl.mjs <input.BGL> [output.json]");
const input = path.resolve(inputArg);
const output = path.resolve(outputArg ?? `${inputArg}.inspection.json`);
const data = fs.readFileSync(input);
const u16 = (offset) => data.readUInt16LE(offset);
const u32 = (offset) => data.readUInt32LE(offset);
const i32 = (offset) => data.readInt32LE(offset);
const f32 = (offset) => data.readFloatLE(offset);
const lonDeg = (raw) => raw * (360 / (3 * 0x10000000)) - 180;
const latDeg = (raw) => 90 - raw * (180 / (2 * 0x10000000));

if (data.length < 0x38 || u32(0) !== 0x19920201 || u32(4) !== 0x38) {
  throw new Error(`${inputArg} is not an FSX-format BGL file`);
}

function guidAt(offset) {
  if (offset < 0 || offset + 16 > data.length) return null;
  const a = data.readUInt32LE(offset).toString(16).padStart(8, "0");
  const b = data.readUInt16LE(offset + 4).toString(16).padStart(4, "0");
  const c = data.readUInt16LE(offset + 6).toString(16).padStart(4, "0");
  const d = [...data.subarray(offset + 8, offset + 10)].map((value) => value.toString(16).padStart(2, "0")).join("");
  const e = [...data.subarray(offset + 10, offset + 16)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `{${a}-${b}-${c}-${d}-${e}}`;
}

function finiteFloat(value) {
  return Number.isFinite(value) && Math.abs(value) < 1e7 ? value : null;
}

function recordEvidence(offset, size, id) {
  const end = Math.min(data.length, offset + size);
  const rawUint16 = [];
  const rawUint32 = [];
  const rawFloat32 = [];
  for (let relative = 0; relative + 2 <= Math.min(size, 64); relative += 2) rawUint16.push(u16(offset + relative));
  for (let relative = 0; relative + 4 <= Math.min(size, 64); relative += 4) {
    rawUint32.push(u32(offset + relative));
    rawFloat32.push(finiteFloat(f32(offset + relative)));
  }
  const coordinateCandidates = [];
  for (let relative = 6; relative + 8 <= Math.min(size, 48); relative += 2) {
    const longitude = lonDeg(u32(offset + relative));
    const latitude = latDeg(u32(offset + relative + 4));
    if (longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90) {
      coordinateCandidates.push({ relativeOffset: relative, longitude, latitude });
    }
  }
  const guidCandidates = [];
  for (let relative = 6; relative + 16 <= size; relative += 2) {
    const bytes = data.subarray(offset + relative, offset + relative + 16);
    const allZero = bytes.every((value) => value === 0);
    const allFF = bytes.every((value) => value === 0xff);
    if (!allZero && !allFF) guidCandidates.push({ relativeOffset: relative, guid: guidAt(offset + relative) });
  }
  return {
    sourceByteOffset: offset,
    id,
    idHex: `0x${id.toString(16).padStart(4, "0")}`,
    size,
    rawHex: data.subarray(offset, Math.min(end, offset + 96)).toString("hex"),
    rawUint16,
    rawUint32,
    rawFloat32,
    coordinateCandidates,
    guidCandidates: guidCandidates.slice(-8),
  };
}

const sectionCount = u32(0x14);
const sections = [];
for (let index = 0; index < sectionCount; index += 1) {
  const offset = 0x38 + index * 20;
  if (offset + 20 > data.length) break;
  const type = u32(offset);
  const flags = u32(offset + 4);
  const subsectionCount = u32(offset + 8);
  const subsectionOffset = u32(offset + 12);
  const subsectionBytes = u32(offset + 16);
  const subsectionSize = ((flags & 0x10000) | 0x40000) >>> 14;
  const section = {
    index,
    type,
    typeHex: `0x${type.toString(16).padStart(8, "0")}`,
    flags,
    subsectionCount,
    subsectionOffset,
    subsectionBytes,
    subsectionSize,
    subsections: [],
  };
  for (let subsectionIndex = 0; subsectionIndex < subsectionCount; subsectionIndex += 1) {
    const subsectionHeader = subsectionOffset + subsectionIndex * subsectionSize;
    if (subsectionHeader + Math.min(subsectionSize, 16) > data.length) break;
    const recordCount = u32(subsectionHeader + 4);
    const dataOffset = u32(subsectionHeader + 8);
    const dataBytes = u32(subsectionHeader + 12);
    const dataEnd = Math.min(data.length, dataOffset + dataBytes);
    const records = [];
    let cursor = dataOffset;
    while (cursor + 6 <= dataEnd && records.length < Math.max(recordCount, 1)) {
      const id = u16(cursor);
      const size = u32(cursor + 2);
      if (size < 6 || cursor + size > dataEnd) break;
      records.push(recordEvidence(cursor, size, id));
      cursor += size;
    }
    section.subsections.push({
      index: subsectionIndex,
      sourceByteOffset: subsectionHeader,
      recordCount,
      dataOffset,
      dataBytes,
      decodedRecordCount: records.length,
      records,
    });
  }
  sections.push(section);
}

const summary = {
  schemaVersion: 1,
  source: path.relative(process.cwd(), input).replaceAll("\\", "/"),
  sourceBytes: data.length,
  sectionCount,
  sections,
  decodedRecordCount: sections.reduce((total, section) => total + section.subsections.reduce((subtotal, subsection) => subtotal + subsection.decodedRecordCount, 0), 0),
  interpretation: "format-preserving section and record evidence; coordinate and GUID candidates are emitted without assigning placement semantics",
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify({ source: summary.source, sourceBytes: summary.sourceBytes, sectionCount: summary.sectionCount, decodedRecordCount: summary.decodedRecordCount, sectionTypes: sections.map((section) => section.typeHex) }, null, 2));
