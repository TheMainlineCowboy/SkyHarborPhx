import fs from "node:fs";
import path from "node:path";

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error("Usage: node scripts/obj-to-gltf.mjs <input.obj> <output.gltf>");
  process.exit(2);
}

const input = path.resolve(inputArg);
const output = path.resolve(outputArg);
const outputDir = path.dirname(output);
fs.mkdirSync(outputDir, { recursive: true });

const source = fs.readFileSync(input, "utf8");
const sourceDir = path.dirname(input);
const rawPositions = [];
const rawUvs = [];
const rawNormals = [];
const vertices = new Map();
const positions = [];
const uvs = [];
const normals = [];
const primitiveIndices = new Map();
let currentMaterial = "default";
let mtlFile = null;
let hasUv = false;
let hasNormal = false;

const resolveIndex = (raw, count) => {
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value === 0) return null;
  return value > 0 ? value - 1 : count + value;
};

function addVertex(token) {
  if (vertices.has(token)) return vertices.get(token);
  const [vRaw, vtRaw = "", vnRaw = ""] = token.split("/");
  const vi = resolveIndex(vRaw, rawPositions.length);
  const ti = vtRaw ? resolveIndex(vtRaw, rawUvs.length) : null;
  const ni = vnRaw ? resolveIndex(vnRaw, rawNormals.length) : null;
  if (vi == null || !rawPositions[vi]) throw new Error(`Invalid OBJ position index in ${token}`);
  const index = positions.length / 3;
  positions.push(...rawPositions[vi]);
  if (ti != null && rawUvs[ti]) {
    uvs.push(...rawUvs[ti]);
    hasUv = true;
  } else {
    uvs.push(0, 0);
  }
  if (ni != null && rawNormals[ni]) {
    normals.push(...rawNormals[ni]);
    hasNormal = true;
  } else {
    normals.push(0, 0, 0);
  }
  vertices.set(token, index);
  return index;
}

for (const rawLine of source.split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const firstSpace = line.indexOf(" ");
  const keyword = firstSpace < 0 ? line : line.slice(0, firstSpace);
  const rest = firstSpace < 0 ? "" : line.slice(firstSpace + 1).trim();
  if (keyword === "v") {
    const values = rest.split(/\s+/).slice(0, 3).map(Number);
    if (values.length === 3 && values.every(Number.isFinite)) rawPositions.push(values);
  } else if (keyword === "vt") {
    const values = rest.split(/\s+/).slice(0, 2).map(Number);
    if (values.length >= 2 && values.every(Number.isFinite)) rawUvs.push([values[0], 1 - values[1]]);
  } else if (keyword === "vn") {
    const values = rest.split(/\s+/).slice(0, 3).map(Number);
    if (values.length === 3 && values.every(Number.isFinite)) rawNormals.push(values);
  } else if (keyword === "mtllib") {
    mtlFile = rest.split(/\s+/)[0] || null;
  } else if (keyword === "usemtl") {
    currentMaterial = rest || "default";
  } else if (keyword === "f") {
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens.length < 3) continue;
    const face = tokens.map(addVertex);
    const list = primitiveIndices.get(currentMaterial) ?? [];
    for (let i = 1; i < face.length - 1; i += 1) list.push(face[0], face[i], face[i + 1]);
    primitiveIndices.set(currentMaterial, list);
  }
}

if (positions.length < 9 || primitiveIndices.size === 0) throw new Error("OBJ did not contain usable triangle geometry");

const materialDefs = new Map([["default", { color: [0.72, 0.72, 0.72, 1] }]]);
if (mtlFile) {
  const mtlPath = path.resolve(sourceDir, mtlFile);
  if (fs.existsSync(mtlPath)) {
    let active = null;
    for (const rawLine of fs.readFileSync(mtlPath, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const [key, ...parts] = line.split(/\s+/);
      if (key === "newmtl") {
        active = parts.join(" ") || "default";
        if (!materialDefs.has(active)) materialDefs.set(active, { color: [0.72, 0.72, 0.72, 1] });
      } else if (key === "Kd" && active) {
        const rgb = parts.slice(0, 3).map(Number);
        if (rgb.length === 3 && rgb.every(Number.isFinite)) materialDefs.get(active).color = [...rgb, 1];
      } else if (key === "d" && active) {
        const alpha = Number(parts[0]);
        if (Number.isFinite(alpha)) materialDefs.get(active).color[3] = alpha;
      } else if (key === "Tr" && active) {
        const transparency = Number(parts[0]);
        if (Number.isFinite(transparency)) materialDefs.get(active).color[3] = 1 - transparency;
      }
    }
  }
}

const chunks = [];
let byteLength = 0;
const bufferViews = [];
const accessors = [];
const align4 = () => {
  const padding = (4 - (byteLength % 4)) % 4;
  if (padding) { chunks.push(Buffer.alloc(padding)); byteLength += padding; }
};
const append = (buffer, target) => {
  align4();
  const index = bufferViews.length;
  bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: buffer.length, ...(target ? { target } : {}) });
  chunks.push(buffer);
  byteLength += buffer.length;
  return index;
};
const addAccessor = (view, componentType, count, type, min, max) => {
  const index = accessors.length;
  accessors.push({ bufferView: view, componentType, count, type, ...(min ? { min } : {}), ...(max ? { max } : {}) });
  return index;
};

const vertexCount = positions.length / 3;
const posArray = Float32Array.from(positions);
const posMin = [Infinity, Infinity, Infinity];
const posMax = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) {
  for (let axis = 0; axis < 3; axis += 1) {
    posMin[axis] = Math.min(posMin[axis], positions[i + axis]);
    posMax[axis] = Math.max(posMax[axis], positions[i + axis]);
  }
}
const posAccessor = addAccessor(append(Buffer.from(posArray.buffer), 34962), 5126, vertexCount, "VEC3", posMin, posMax);
let uvAccessor = null;
let normalAccessor = null;
if (hasUv) uvAccessor = addAccessor(append(Buffer.from(Float32Array.from(uvs).buffer), 34962), 5126, vertexCount, "VEC2");
if (hasNormal) normalAccessor = addAccessor(append(Buffer.from(Float32Array.from(normals).buffer), 34962), 5126, vertexCount, "VEC3");

const materialNames = [...primitiveIndices.keys()];
const materials = materialNames.map((name) => {
  const def = materialDefs.get(name) ?? materialDefs.get("default");
  const alpha = def.color[3];
  return {
    name,
    pbrMetallicRoughness: { baseColorFactor: def.color, metallicFactor: 0, roughnessFactor: 0.82 },
    ...(alpha < 0.999 ? { alphaMode: "BLEND", doubleSided: true } : {}),
  };
});

const primitives = [];
for (let materialIndex = 0; materialIndex < materialNames.length; materialIndex += 1) {
  const indices = primitiveIndices.get(materialNames[materialIndex]);
  if (!indices?.length) continue;
  const indexArray = Uint32Array.from(indices);
  const indexAccessor = addAccessor(append(Buffer.from(indexArray.buffer), 34963), 5125, indexArray.length, "SCALAR", [Math.min(...indices)], [Math.max(...indices)]);
  const attributes = { POSITION: posAccessor };
  if (uvAccessor != null) attributes.TEXCOORD_0 = uvAccessor;
  if (normalAccessor != null) attributes.NORMAL = normalAccessor;
  primitives.push({ attributes, indices: indexAccessor, material: materialIndex, mode: 4 });
}

align4();
const binName = `${path.basename(output, path.extname(output))}.bin`;
fs.writeFileSync(path.join(outputDir, binName), Buffer.concat(chunks, byteLength));

const gltf = {
  asset: { version: "2.0", generator: "RampReady dependency-free OBJ to glTF converter" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "PHX_Terminal4_Authored", mesh: 0 }],
  meshes: [{ name: "PHX_Terminal4_AuthoredMesh", primitives }],
  materials,
  buffers: [{ uri: binName, byteLength }],
  bufferViews,
  accessors,
  extras: {
    sourceObj: path.basename(input),
    sourcePositions: rawPositions.length,
    sourceUvs: rawUvs.length,
    sourceNormals: rawNormals.length,
    uniqueVertices: vertexCount,
    triangles: [...primitiveIndices.values()].reduce((sum, indices) => sum + indices.length / 3, 0),
    materialCount: materialNames.length,
    bounds: { min: posMin, max: posMax },
  },
};
fs.writeFileSync(output, `${JSON.stringify(gltf, null, 2)}\n`, "utf8");
console.log(JSON.stringify(gltf.extras));
