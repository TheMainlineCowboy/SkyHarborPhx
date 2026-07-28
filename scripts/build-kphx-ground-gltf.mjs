import fs from "node:fs";
import path from "node:path";

const [inspectionArg = "inspection.json", outputDirArg = "kphx-ground"] = process.argv.slice(2);
const inspectionPath = path.resolve(inspectionArg);
const outputDir = path.resolve(outputDirArg);
fs.mkdirSync(outputDir, { recursive: true });

const inspection = JSON.parse(fs.readFileSync(inspectionPath, "utf8"));
const airport = inspection.selected;
if (inspection.selectedAirport !== "KPHX") throw new Error(`Expected KPHX, got ${inspection.selectedAirport}`);

// FSX parking-name code 12 is Gate A. Anchor the browser coordinate system at authored A1.
const a1 = airport.parkings.find((parking) => parking.nameCode === 12 && parking.number === 1);
if (!a1) throw new Error("A1 parking anchor is missing");

const EARTH_RADIUS_METERS = 6378137;
const originLatitudeRadians = airport.origin.latitude * Math.PI / 180;
const anchorEast = (a1.longitude - airport.origin.longitude) * Math.PI / 180 * EARTH_RADIUS_METERS * Math.cos(originLatitudeRadians);
const anchorNorth = (a1.latitude - airport.origin.latitude) * Math.PI / 180 * EARTH_RADIUS_METERS;
const toScene = (longitude, latitude) => {
  const east = (longitude - airport.origin.longitude) * Math.PI / 180 * EARTH_RADIUS_METERS * Math.cos(originLatitudeRadians);
  const north = (latitude - airport.origin.latitude) * Math.PI / 180 * EARTH_RADIUS_METERS;
  // X=north and Z=east makes A1's authored ~270-degree heading face scene -Z,
  // matching RampReady's aircraft/training orientation.
  return [north - anchorNorth, east - anchorEast];
};

const groups = new Map();
const ensureGroup = (name) => {
  if (!groups.has(name)) groups.set(name, { positions: [], normals: [], uvs: [], triangles: 0 });
  return groups.get(name);
};
const addTriangle = (name, a, b, c, y = 0) => {
  const group = ensureGroup(name);
  for (const point of [a, b, c]) {
    group.positions.push(point[0], y, point[1]);
    group.normals.push(0, 1, 0);
    group.uvs.push(point[0] / 64, point[1] / 64);
  }
  group.triangles += 1;
};
const addQuad = (name, a, b, c, d, y = 0) => {
  addTriangle(name, a, b, c, y);
  addTriangle(name, a, c, d, y);
};
const addStrip = (name, a, b, width, y = 0) => {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (!(length > 0.01) || !(width > 0)) return;
  const nx = -dz / length * width / 2;
  const nz = dx / length * width / 2;
  addQuad(
    name,
    [a[0] + nx, a[1] + nz],
    [b[0] + nx, b[1] + nz],
    [b[0] - nx, b[1] - nz],
    [a[0] - nx, a[1] - nz],
    y,
  );
};
const surfaceName = (surface, pathType) => {
  if (pathType === 6) return "service-road";
  return surface === 4 ? "asphalt" : "concrete";
};

const allCoordinates = [];
for (const point of airport.taxiwayPoints) allCoordinates.push(toScene(point.longitude, point.latitude));
for (const parking of airport.parkings) allCoordinates.push(toScene(parking.longitude, parking.latitude));
for (const apron of airport.aprons) {
  for (const vertex of apron.vertices) allCoordinates.push(toScene(vertex.longitude, vertex.latitude));
}
const boundsMin = [
  Math.min(...allCoordinates.map((point) => point[0])),
  Math.min(...allCoordinates.map((point) => point[1])),
];
const boundsMax = [
  Math.max(...allCoordinates.map((point) => point[0])),
  Math.max(...allCoordinates.map((point) => point[1])),
];
const baseMarginMeters = 350;
addQuad(
  "airport-base",
  [boundsMin[0] - baseMarginMeters, boundsMin[1] - baseMarginMeters],
  [boundsMax[0] + baseMarginMeters, boundsMin[1] - baseMarginMeters],
  [boundsMax[0] + baseMarginMeters, boundsMax[1] + baseMarginMeters],
  [boundsMin[0] - baseMarginMeters, boundsMax[1] + baseMarginMeters],
  -0.08,
);

let apronTriangles = 0;
for (const apron of airport.aprons) {
  if (!apron.triangles?.length) continue;
  const points = apron.vertices.map((vertex) => toScene(vertex.longitude, vertex.latitude));
  const materialName = surfaceName(apron.surface, 0);
  for (const triangle of apron.triangles) {
    const [a, b, c] = triangle.map((index) => points[index]);
    if (!a || !b || !c) continue;
    addTriangle(materialName, a, b, c, 0.005);
    apronTriangles += 1;
  }
}

const pointFor = (index) => {
  const point = airport.taxiwayPoints[index];
  return point ? toScene(point.longitude, point.latitude) : null;
};
const parkingFor = (index) => {
  const parking = airport.parkings[index];
  return parking ? toScene(parking.longitude, parking.latitude) : null;
};
let pathSurfaces = 0;
let markingSegments = 0;
for (const taxiwayPath of airport.taxiwayPaths) {
  const start = pointFor(taxiwayPath.start);
  // FSX parking paths (type 3) point to the parking-table index rather than a taxiway point.
  const end = taxiwayPath.type === 3 ? parkingFor(taxiwayPath.end) : pointFor(taxiwayPath.end);
  if (!start || !end) continue;

  if (taxiwayPath.type !== 3 && taxiwayPath.widthMeters > 0.5) {
    addStrip(surfaceName(taxiwayPath.surface, taxiwayPath.type), start, end, taxiwayPath.widthMeters, 0.012);
    pathSurfaces += 1;
  }

  const shouldMark = taxiwayPath.centerline || taxiwayPath.type === 2 || taxiwayPath.type === 3 || taxiwayPath.type === 6;
  if (shouldMark) {
    const materialName = taxiwayPath.type === 2 || taxiwayPath.type === 6 ? "white-marking" : "yellow-marking";
    const width = taxiwayPath.type === 2 ? 0.28 : taxiwayPath.type === 6 ? 0.12 : 0.18;
    addStrip(materialName, start, end, width, 0.035);
    markingSegments += 1;
  }
}

const materialDefinitions = [
  ["airport-base", [0.37, 0.34, 0.30, 1], 0.96],
  ["concrete", [0.49, 0.50, 0.49, 1], 0.92],
  ["asphalt", [0.23, 0.25, 0.27, 1], 0.94],
  ["service-road", [0.29, 0.30, 0.31, 1], 0.94],
  ["yellow-marking", [1, 0.73, 0, 1], 0.78],
  ["white-marking", [0.94, 0.94, 0.90, 1], 0.80],
];

const chunks = [];
const bufferViews = [];
const accessors = [];
let byteLength = 0;
const align = () => {
  const padding = (4 - byteLength % 4) % 4;
  if (padding) {
    chunks.push(Buffer.alloc(padding));
    byteLength += padding;
  }
};
const append = (typedArray, target) => {
  align();
  const buffer = Buffer.from(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  const index = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.length, target });
  chunks.push(buffer);
  byteLength += buffer.length;
  return index;
};
const addAccessor = (bufferView, count, type, min, max) => {
  const index = accessors.length;
  accessors.push({ bufferView, componentType: 5126, count, type, ...(min ? { min } : {}), ...(max ? { max } : {}) });
  return index;
};

const primitives = [];
const materials = [];
for (const [name, color, roughness] of materialDefinitions) {
  const group = groups.get(name);
  if (!group?.positions.length) continue;
  const positions = Float32Array.from(group.positions);
  const normals = Float32Array.from(group.normals);
  const uvs = Float32Array.from(group.uvs);
  const primitiveMin = [Infinity, Infinity, Infinity];
  const primitiveMax = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < group.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      primitiveMin[axis] = Math.min(primitiveMin[axis], group.positions[index + axis]);
      primitiveMax[axis] = Math.max(primitiveMax[axis], group.positions[index + axis]);
    }
  }
  const attributes = {
    POSITION: addAccessor(append(positions, 34962), positions.length / 3, "VEC3", primitiveMin, primitiveMax),
    NORMAL: addAccessor(append(normals, 34962), normals.length / 3, "VEC3"),
    TEXCOORD_0: addAccessor(append(uvs, 34962), uvs.length / 2, "VEC2"),
  };
  const material = materials.length;
  materials.push({
    name,
    pbrMetallicRoughness: { baseColorFactor: color, metallicFactor: 0, roughnessFactor: roughness },
    doubleSided: true,
  });
  primitives.push({ attributes, material, mode: 4, extras: { triangleCount: group.triangles, layer: name } });
}

align();
const binName = "kphx-ground.bin";
fs.writeFileSync(path.join(outputDir, binName), Buffer.concat(chunks, byteLength));
const extras = {
  source: "KPHX_ADEX.BGL",
  airport: "KPHX",
  coordinateFrame: "A1-local; X=north, Y=up, Z=east",
  anchor: {
    gate: "A1",
    parkingIndex: a1.index,
    headingDegrees: a1.headingDegrees,
    longitude: a1.longitude,
    latitude: a1.latitude,
  },
  counts: {
    taxiwayPoints: airport.taxiwayPoints.length,
    taxiwayPaths: airport.taxiwayPaths.length,
    parkings: airport.parkings.length,
    apronRecords: airport.aprons.length,
    apronTriangles,
    pathSurfaces,
    markingSegments,
  },
  bounds: { min: boundsMin, max: boundsMax, margin: baseMarginMeters },
};
const gltf = {
  asset: { version: "2.0", generator: "RampReady KPHX ADEX ground builder" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "PHX_KPHX_AuthoredGround", mesh: 0 }],
  meshes: [{ name: "PHX_KPHX_AuthoredGroundMesh", primitives }],
  materials,
  buffers: [{ uri: binName, byteLength }],
  bufferViews,
  accessors,
  extras,
};
fs.writeFileSync(path.join(outputDir, "kphx-ground.gltf"), `${JSON.stringify(gltf, null, 2)}\n`);
fs.writeFileSync(path.join(outputDir, "ground-manifest.json"), `${JSON.stringify(extras, null, 2)}\n`);
console.log(JSON.stringify({ binBytes: byteLength, primitiveCount: primitives.length, ...extras }, null, 2));