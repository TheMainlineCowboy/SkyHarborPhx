import fs from "node:fs";
import path from "node:path";

const [inputArg = "scenery/KPHX_ADEX.BGL", outputArg = "web-extract/kphx-adex/inspection.json"] = process.argv.slice(2);
const input = path.resolve(inputArg);
const output = path.resolve(outputArg);
const data = fs.readFileSync(input);

const u8 = (o) => data.readUInt8(o);
const u16 = (o) => data.readUInt16LE(o);
const u32 = (o) => data.readUInt32LE(o);
const f32 = (o) => data.readFloatLE(o);
const safeU32 = (o) => (o >= 0 && o + 4 <= data.length ? u32(o) : null);

const lonDeg = (raw) => raw * (360 / (3 * 0x10000000)) - 180;
const latDeg = (raw) => 90 - raw * (180 / (2 * 0x10000000));
const charFor = (value) => {
  if (value === 0) return " ";
  if (value >= 2 && value <= 11) return String.fromCharCode(48 + value - 2);
  if (value >= 12 && value <= 37) return String.fromCharCode(65 + value - 12);
  return "?";
};
const decodeIcao = (raw, shifted = true) => {
  let value = shifted ? raw >>> 5 : raw;
  if (!value) return "";
  const chars = [];
  while (value > 37) {
    const next = value % 38;
    chars.unshift(charFor(next));
    value = Math.floor((value - next) / 38);
  }
  chars.unshift(charFor(value));
  return chars.join("").trim();
};

if (data.length < 0x38 || u32(0) !== 0x19920201 || u32(4) !== 0x38) {
  throw new Error("Not an FSX-format BGL file");
}

const sectionCount = u32(0x14);
const sections = [];
for (let index = 0; index < sectionCount; index += 1) {
  const o = 0x38 + index * 20;
  if (o + 20 > data.length) throw new Error(`Section pointer ${index} exceeds file`);
  const type = u32(o);
  const flags = u32(o + 4);
  const subsectionCount = u32(o + 8);
  const subsectionOffset = u32(o + 12);
  const subsectionBytes = u32(o + 16);
  const subsectionSize = ((flags & 0x10000) | 0x40000) >>> 14;
  sections.push({ index, type, flags, subsectionCount, subsectionOffset, subsectionBytes, subsectionSize });
}

const airportSection = sections.find((section) => section.type === 0x03);
if (!airportSection) throw new Error("KPHX_ADEX.BGL has no Airport section (type 0x03)");

const airportRecords = [];
for (let subIndex = 0; subIndex < airportSection.subsectionCount; subIndex += 1) {
  const s = airportSection.subsectionOffset + subIndex * airportSection.subsectionSize;
  if (s + airportSection.subsectionSize > data.length) break;
  const recordCount = u32(s + 4);
  const dataOffset = u32(s + 8);
  const dataBytes = u32(s + 12);
  const dataEnd = Math.min(data.length, dataOffset + dataBytes);
  let cursor = dataOffset;
  for (let recordIndex = 0; recordIndex < Math.max(recordCount, 1) && cursor + 6 <= dataEnd; recordIndex += 1) {
    const id = u16(cursor);
    const size = u32(cursor + 2);
    if (id !== 0x003c || size < 0x38 || cursor + size > dataEnd) break;
    const origin = {
      longitude: lonDeg(u32(cursor + 0x0c)),
      latitude: latDeg(u32(cursor + 0x10)),
      altitudeMeters: u32(cursor + 0x14) / 1000,
    };
    const airport = {
      id,
      size,
      icao: decodeIcao(u32(cursor + 0x28), true),
      origin,
      magneticVariation: f32(cursor + 0x24),
      counts: {
        runways: u8(cursor + 0x06),
        comms: u8(cursor + 0x07),
        starts: u8(cursor + 0x08),
        approaches: u8(cursor + 0x09),
        aprons: u8(cursor + 0x0a) & 0x7f,
        helipads: u8(cursor + 0x0b),
      },
      subrecords: [],
      taxiwayPoints: [],
      taxiwayPaths: [],
      taxiwayNames: [],
      parkings: [],
      aprons: [],
      perimeterMeshes: [],
    };
    let child = cursor + 0x38;
    const end = cursor + size;
    while (child + 6 <= end) {
      const childId = u16(child);
      const childSize = u32(child + 2);
      if (childSize < 6 || child + childSize > end) {
        airport.subrecords.push({ id: childId, offset: child - cursor, size: childSize, invalid: true });
        break;
      }
      airport.subrecords.push({ id: childId, offset: child - cursor, size: childSize });
      if (childId === 0x001a && childSize >= 8) {
        const count = u16(child + 6);
        for (let i = 0; i < count; i += 1) {
          const p = child + 8 + i * 12;
          if (p + 12 > child + childSize) break;
          airport.taxiwayPoints.push({
            index: i,
            type: u8(p),
            orientation: u8(p + 1),
            longitude: lonDeg(u32(p + 4)),
            latitude: latDeg(u32(p + 8)),
          });
        }
      } else if (childId === 0x001c && childSize >= 8) {
        const count = u16(child + 6);
        for (let i = 0; i < count; i += 1) {
          const p = child + 8 + i * 20;
          if (p + 20 > child + childSize) break;
          const endRaw = u16(p + 2);
          const typeFlags = u8(p + 4);
          const edgeFlags = u8(p + 6);
          airport.taxiwayPaths.push({
            index: i,
            start: u16(p),
            end: endRaw & 0x0fff,
            runwayDesignator: endRaw >>> 12,
            type: typeFlags & 0x1f,
            drawSurface: Boolean(typeFlags & 0x20),
            drawDetail: Boolean(typeFlags & 0x40),
            nameIndex: u8(p + 5),
            centerline: Boolean(edgeFlags & 0x01),
            centerlineLighted: Boolean(edgeFlags & 0x02),
            leftEdge: (edgeFlags >>> 2) & 0x03,
            leftEdgeLighted: Boolean(edgeFlags & 0x10),
            rightEdge: (edgeFlags >>> 5) & 0x03,
            rightEdgeLighted: Boolean(edgeFlags & 0x80),
            surface: u8(p + 7),
            widthMeters: f32(p + 8),
            weightLimit: f32(p + 12),
          });
        }
      } else if (childId === 0x001d && childSize >= 8) {
        const count = u16(child + 6);
        for (let i = 0; i < count; i += 1) {
          const p = child + 8 + i * 8;
          if (p + 8 > child + childSize) break;
          airport.taxiwayNames.push(data.toString("ascii", p, p + 8).replace(/\0.*$/, "").trim());
        }
      } else if (childId === 0x003d && childSize >= 8) {
        const count = u16(child + 6);
        let p = child + 8;
        for (let i = 0; i < count && p + 36 <= child + childSize; i += 1) {
          const packed = u32(p);
          const airlineCount = packed >>> 24;
          airport.parkings.push({
            index: i,
            airlineCount,
            number: (packed >>> 12) & 0x0fff,
            parkingType: (packed >>> 8) & 0x0f,
            pushback: (packed >>> 6) & 0x03,
            nameCode: packed & 0x3f,
            radiusMeters: f32(p + 4),
            headingDegrees: f32(p + 8),
            longitude: lonDeg(u32(p + 0x1c)),
            latitude: latDeg(u32(p + 0x20)),
          });
          p += 36 + airlineCount * 4;
        }
      } else if (childId === 0x0030 && childSize >= 12) {
        const surface = u8(child + 6);
        const flags = u8(child + 7);
        const vertexCount = u16(child + 8);
        const triangleCount = u16(child + 10);
        const vertices = [];
        let p = child + 12;
        for (let i = 0; i < vertexCount && p + 8 <= child + childSize; i += 1, p += 8) {
          vertices.push({ longitude: lonDeg(u32(p)), latitude: latDeg(u32(p + 4)) });
        }
        const triangles = [];
        for (let i = 0; i < triangleCount && p + 6 <= child + childSize; i += 1, p += 6) {
          triangles.push([u16(p), u16(p + 2), u16(p + 4)]);
        }
        airport.aprons.push({ recordType: childId, surface, flags, vertices, triangles });
      } else if (childId === 0x0037 && childSize >= 9) {
        const surface = u8(child + 6);
        const vertexCount = u16(child + 7);
        const vertices = [];
        let p = child + 9;
        for (let i = 0; i < vertexCount && p + 8 <= child + childSize; i += 1, p += 8) {
          vertices.push({ longitude: lonDeg(u32(p)), latitude: latDeg(u32(p + 4)) });
        }
        airport.aprons.push({ recordType: childId, surface, vertices, triangles: [] });
      } else if (childId === 0x003b && childSize >= 12) {
        const vertexCount = u16(child + 8);
        const triangleCount = u16(child + 10);
        const vertices = [];
        let p = child + 12;
        for (let i = 0; i < vertexCount && p + 8 <= child + childSize; i += 1, p += 8) {
          vertices.push({ longitude: lonDeg(u32(p)), latitude: latDeg(u32(p + 4)) });
        }
        const triangles = [];
        for (let i = 0; i < triangleCount && p + 6 <= child + childSize; i += 1, p += 6) {
          triangles.push([u16(p), u16(p + 2), u16(p + 4)]);
        }
        airport.perimeterMeshes.push({ vertices, triangles });
      }
      child += childSize;
    }
    airportRecords.push(airport);
    cursor += size;
  }
}

const kphx = airportRecords.find((airport) => airport.icao === "KPHX") ?? airportRecords[0];
if (!kphx) throw new Error("No airport record was decoded from KPHX_ADEX.BGL");

const summary = {
  schemaVersion: 1,
  source: path.relative(process.cwd(), input).replaceAll("\\", "/"),
  sourceBytes: data.length,
  sectionCount,
  sections,
  airportCount: airportRecords.length,
  selectedAirport: kphx.icao,
  selected: kphx,
  decodedCounts: {
    taxiwayPoints: kphx.taxiwayPoints.length,
    taxiwayPaths: kphx.taxiwayPaths.length,
    taxiwayNames: kphx.taxiwayNames.length,
    parkings: kphx.parkings.length,
    apronRecords: kphx.aprons.length,
    perimeterMeshes: kphx.perimeterMeshes.length,
  },
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ selectedAirport: summary.selectedAirport, counts: summary.decodedCounts, origin: kphx.origin, subrecords: kphx.subrecords.map(({ id, size, invalid }) => ({ id: `0x${id.toString(16).padStart(4, "0")}`, size, invalid: Boolean(invalid) })) }, null, 2));