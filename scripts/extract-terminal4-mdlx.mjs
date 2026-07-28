import fs from "node:fs";
import path from "node:path";

const [inputArg = "scenery/term4.BGL", outputDirArg = "web-extract/terminal4"] = process.argv.slice(2);
const input = path.resolve(inputArg);
const outputDir = path.resolve(outputDirArg);
fs.mkdirSync(outputDir, { recursive: true });

const data = fs.readFileSync(input);
const fourCC = (offset) => data.toString("ascii", offset, offset + 4);
const u32 = (buffer, offset) => buffer.readUInt32LE(offset);
const i32 = (buffer, offset) => buffer.readInt32LE(offset);
const i16 = (buffer, offset) => buffer.readInt16LE(offset);
const f32 = (buffer, offset) => buffer.readFloatLE(offset);

function scanMdlx() {
  const found = [];
  for (let offset = 0; offset + 12 <= data.length; offset += 1) {
    if (fourCC(offset) !== "RIFF" || fourCC(offset + 8) !== "MDLX") continue;
    const riffSize = u32(data, offset + 4);
    const end = offset + 8 + riffSize;
    if (riffSize < 12 || end > data.length) continue;
    found.push({ offset, size: 8 + riffSize, end });
    offset = end - 1;
  }
  return found;
}

function chunks(buffer, start, end, prefixBytes = 0) {
  const result = [];
  let offset = start + prefixBytes;
  while (offset + 8 <= end) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = u32(buffer, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (!/^[\x20-\x7e]{4}$/.test(id) || dataEnd > end) break;
    result.push({ id, offset, size, dataStart, dataEnd });
    offset = dataEnd + (size & 1);
  }
  return result;
}

function childChunks(buffer, chunk, prefixBytes = 0) {
  return chunks(buffer, chunk.dataStart, chunk.dataEnd, prefixBytes);
}

function readCString(buffer, start, end) {
  let stop = start;
  while (stop < end && buffer[stop] !== 0) stop += 1;
  return buffer.toString("ascii", start, stop);
}

function matIdentity() {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
}
function matMul(a, b) {
  const out = new Array(16).fill(0);
  for (let row = 0; row < 4; row += 1) {
    for (let col = 0; col < 4; col += 1) {
      for (let k = 0; k < 4; k += 1) out[row * 4 + col] += a[row * 4 + k] * b[k * 4 + col];
    }
  }
  return out;
}
function transformPoint(m, [x, y, z]) {
  return [
    x*m[0] + y*m[4] + z*m[8] + m[12],
    x*m[1] + y*m[5] + z*m[9] + m[13],
    x*m[2] + y*m[6] + z*m[10] + m[14],
  ];
}
function transformNormal(m, [x, y, z]) {
  const nx = x*m[0] + y*m[4] + z*m[8];
  const ny = x*m[1] + y*m[5] + z*m[9];
  const nz = x*m[2] + y*m[6] + z*m[10];
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx/len, ny/len, nz/len];
}

function parseModel(entry, modelIndex) {
  const mdl = data.subarray(entry.offset, entry.end);
  if (mdl.toString("ascii", 0, 4) !== "RIFF" || mdl.toString("ascii", 8, 12) !== "MDLX") throw new Error("Not an MDLX RIFF");
  const top = chunks(mdl, 12, mdl.length);
  const findTop = (id) => top.find((chunk) => chunk.id === id);
  const nameChunk = findTop("MDLN");
  const name = nameChunk ? readCString(mdl, nameChunk.dataStart, nameChunk.dataEnd) : `model-${modelIndex}`;
  const bboxChunk = findTop("BBOX");
  const declaredBounds = bboxChunk && bboxChunk.size >= 24 ? {
    min: [f32(mdl,bboxChunk.dataStart), f32(mdl,bboxChunk.dataStart+4), f32(mdl,bboxChunk.dataStart+8)],
    max: [f32(mdl,bboxChunk.dataStart+12), f32(mdl,bboxChunk.dataStart+16), f32(mdl,bboxChunk.dataStart+20)],
  } : null;
  const mdld = findTop("MDLD");
  if (!mdld) return { name, error: "missing MDLD" };
  const sections = childChunks(mdl, mdld);
  const section = (id) => sections.find((chunk) => chunk.id === id);

  const textures = [];
  const text = section("TEXT");
  if (text) {
    for (let offset = text.dataStart; offset + 64 <= text.dataEnd; offset += 64) {
      textures.push(readCString(mdl, offset, offset + 64));
    }
  }

  const materials = [];
  const mate = section("MATE");
  if (mate) {
    for (let offset = mate.dataStart; offset + 120 <= mate.dataEnd; offset += 120) {
      materials.push({
        flags: u32(mdl, offset),
        flags2: u32(mdl, offset + 4),
        diffuseTexture: i32(mdl, offset + 8),
        emissiveTexture: i32(mdl, offset + 24),
        diffuse: [f32(mdl, offset + 36), f32(mdl, offset + 40), f32(mdl, offset + 44), f32(mdl, offset + 48)],
      });
    }
  }

  const indices = [];
  const inde = section("INDE");
  if (inde) for (let offset = inde.dataStart; offset + 2 <= inde.dataEnd; offset += 2) indices.push(mdl.readUInt16LE(offset));

  const vertexBuffers = [];
  const verb = section("VERB");
  if (verb) {
    for (const vert of childChunks(mdl, verb)) {
      if (vert.id !== "VERT") continue;
      const vertices = [];
      for (let offset = vert.dataStart; offset + 32 <= vert.dataEnd; offset += 32) {
        vertices.push({
          position: [f32(mdl,offset), f32(mdl,offset+4), f32(mdl,offset+8)],
          normal: [f32(mdl,offset+12), f32(mdl,offset+16), f32(mdl,offset+20)],
          uv: [f32(mdl,offset+24), 1 - f32(mdl,offset+28)],
        });
      }
      vertexBuffers.push(vertices);
    }
  }

  const transforms = [];
  const tran = section("TRAN");
  if (tran) {
    for (let offset = tran.dataStart; offset + 64 <= tran.dataEnd; offset += 64) {
      transforms.push(Array.from({ length: 16 }, (_, i) => f32(mdl, offset + i*4)));
    }
  }

  const amap = [];
  const amapChunk = section("AMAP");
  if (amapChunk) {
    for (let offset = amapChunk.dataStart; offset + 8 <= amapChunk.dataEnd; offset += 8) {
      amap.push({ type: i32(mdl, offset), transformIndex: i32(mdl, offset+4) });
    }
  }

  const scene = [];
  const scen = section("SCEN");
  if (scen) {
    for (let offset = scen.dataStart; offset + 8 <= scen.dataEnd; offset += 8) {
      scene.push({ child: i16(mdl,offset), peer: i16(mdl,offset+2), amapOffset: i16(mdl,offset+4), unknown: i16(mdl,offset+6) });
    }
  }

  const parents = new Array(scene.length).fill(-1);
  const walkPeers = (node, parent, seen = new Set()) => {
    let current = node;
    while (current >= 0 && current < scene.length && !seen.has(current)) {
      seen.add(current);
      parents[current] = parent;
      if (scene[current].child >= 0) walkPeers(scene[current].child, current, seen);
      current = scene[current].peer;
    }
  };
  if (scene.length) walkPeers(0, -1);

  const localTransforms = scene.map((node, index) => {
    const amapIndex = node.amapOffset >= 0 && node.amapOffset < amap.length ? node.amapOffset : index;
    const map = amap[amapIndex];
    if (!map || map.type !== 1 || map.transformIndex < 0 || map.transformIndex >= transforms.length) return matIdentity();
    return transforms[map.transformIndex];
  });
  const worldTransforms = new Array(scene.length);
  const worldFor = (nodeIndex) => {
    if (nodeIndex < 0 || nodeIndex >= scene.length) return matIdentity();
    if (worldTransforms[nodeIndex]) return worldTransforms[nodeIndex];
    const parent = parents[nodeIndex];
    const local = localTransforms[nodeIndex] ?? matIdentity();
    worldTransforms[nodeIndex] = parent >= 0 ? matMul(worldFor(parent), local) : local;
    return worldTransforms[nodeIndex];
  };

  const parts = [];
  const lodt = section("LODT");
  if (lodt) {
    for (const lode of childChunks(mdl, lodt)) {
      if (lode.id !== "LODE" || lode.size < 4) continue;
      const lod = i32(mdl, lode.dataStart);
      for (const partChunk of childChunks(mdl, lode, 4)) {
        if (partChunk.id !== "PART" || partChunk.size < 36) continue;
        const o = partChunk.dataStart;
        parts.push({ lod,
          type:i32(mdl,o), scenegraph:i32(mdl,o+4), material:i32(mdl,o+8), vertexBuffer:i32(mdl,o+12),
          vertexOffset:i32(mdl,o+16), vertexCount:i32(mdl,o+20), indexOffset:i32(mdl,o+24), indexCount:i32(mdl,o+28), mouse:i32(mdl,o+32)
        });
      }
    }
  }

  return { name, declaredBounds, textures, materials, indices, vertexBuffers, transforms, amap, scene, parents, worldFor, parts };
}

function triangleIndices(part, raw) {
  const slice = raw.slice(part.indexOffset, part.indexOffset + part.indexCount);
  if (part.type === 1) return slice;
  const out = [];
  if (part.type === 2) {
    for (let i=1;i+1<slice.length;i++) out.push(slice[0],slice[i],slice[i+1]);
  } else if (part.type === 3) {
    for (let i=0;i+2<slice.length;i++) {
      if (i % 2 === 0) out.push(slice[i],slice[i+1],slice[i+2]);
      else out.push(slice[i+1],slice[i],slice[i+2]);
    }
  }
  return out;
}

function writeGltf(model) {
  const highestLod = Math.max(...model.parts.map((p) => p.lod));
  const selectedParts = model.parts.filter((p) => p.lod === highestLod);
  const groups = new Map();
  const boundsMin = [Infinity,Infinity,Infinity];
  const boundsMax = [-Infinity,-Infinity,-Infinity];
  let triangles = 0;
  let skipped = 0;

  for (const part of selectedParts) {
    const vertices = model.vertexBuffers[part.vertexBuffer];
    if (!vertices) { skipped++; continue; }
    const tri = triangleIndices(part, model.indices);
    if (!tri.length) { skipped++; continue; }
    const key = part.material >= 0 ? part.material : 0;
    const group = groups.get(key) ?? { positions:[], normals:[], uvs:[] };
    const matrix = model.worldFor(part.scenegraph);
    for (const rawIndex of tri) {
      const vertex = vertices[part.vertexOffset + rawIndex];
      if (!vertex) { skipped++; continue; }
      const p = transformPoint(matrix, vertex.position);
      const n = transformNormal(matrix, vertex.normal);
      group.positions.push(...p); group.normals.push(...n); group.uvs.push(...vertex.uv);
      for (let axis=0;axis<3;axis++) { boundsMin[axis]=Math.min(boundsMin[axis],p[axis]); boundsMax[axis]=Math.max(boundsMax[axis],p[axis]); }
    }
    triangles += Math.floor(tri.length / 3);
    groups.set(key, group);
  }
  if (!groups.size) throw new Error(`No drawable parts found in ${model.name}`);

  const chunksOut=[]; const bufferViews=[]; const accessors=[]; let byteLength=0;
  const align=()=>{const pad=(4-byteLength%4)%4;if(pad){chunksOut.push(Buffer.alloc(pad));byteLength+=pad;}};
  const append=(typed,target)=>{align();const b=Buffer.from(typed.buffer,typed.byteOffset,typed.byteLength);const i=bufferViews.length;bufferViews.push({buffer:0,byteOffset:byteLength,byteLength:b.length,target});chunksOut.push(b);byteLength+=b.length;return i;};
  const accessor=(view,count,type,min,max)=>{const i=accessors.length;accessors.push({bufferView:view,componentType:5126,count,type,...(min?{min}:{}),...(max?{max}:{})});return i;};

  const gltfMaterials=[]; const primitives=[];
  for (const [materialIndex, group] of groups) {
    const count=group.positions.length/3;
    const pAcc=accessor(append(Float32Array.from(group.positions),34962),count,"VEC3");
    const nAcc=accessor(append(Float32Array.from(group.normals),34962),count,"VEC3");
    const uvAcc=accessor(append(Float32Array.from(group.uvs),34962),count,"VEC2");
    const sourceMaterial=model.materials[materialIndex] ?? { diffuse:[0.7,0.7,0.7,1], diffuseTexture:-1, flags2:0 };
    const base=sourceMaterial.diffuse.map((v,i)=>Number.isFinite(v)?Math.max(0,Math.min(1,v)):(i===3?1:0.7));
    const textureName=sourceMaterial.diffuseTexture>=0 ? model.textures[sourceMaterial.diffuseTexture] ?? null : null;
    const gm=gltfMaterials.length;
    gltfMaterials.push({name:`material-${materialIndex}${textureName?`-${textureName}`:""}`,pbrMetallicRoughness:{baseColorFactor:base,metallicFactor:0,roughnessFactor:0.82},doubleSided:Boolean(sourceMaterial.flags2&8),extras:{fsxMaterialIndex:materialIndex,diffuseTexture:textureName}});
    primitives.push({attributes:{POSITION:pAcc,NORMAL:nAcc,TEXCOORD_0:uvAcc},material:gm,mode:4});
  }
  align();
  const binName="terminal4.bin";
  fs.writeFileSync(path.join(outputDir,binName),Buffer.concat(chunksOut,byteLength));
  const gltf={asset:{version:"2.0",generator:"RampReady direct FSX MDLX extractor"},scene:0,scenes:[{nodes:[0]}],nodes:[{name:"PHX_Terminal4_Authored",mesh:0}],meshes:[{name:model.name,primitives}],materials:gltfMaterials,buffers:[{uri:binName,byteLength}],bufferViews,accessors,extras:{source:"scenery/term4.BGL",modelName:model.name,highestLod,partCount:selectedParts.length,triangleCount:triangles,skipped,bounds:{min:boundsMin,max:boundsMax},declaredBounds:model.declaredBounds,textureNames:model.textures}};
  fs.writeFileSync(path.join(outputDir,"terminal4.gltf"),JSON.stringify(gltf,null,2));
  return gltf.extras;
}

const entries=scanMdlx();
if (!entries.length) throw new Error("No embedded RIFF/MDLX models found in term4.BGL");
const parsed=entries.map(parseModel);
const candidates=parsed.filter((m)=>!m.error && m.parts?.length && m.vertexBuffers?.length);
if (!candidates.length) throw new Error(`Found ${entries.length} MDLX chunks but none contained drawable model data`);
const preferred=candidates.find((m)=>/phx[_-]?term4/i.test(m.name)) ?? candidates.sort((a,b)=>b.parts.length-a.parts.length)[0];
const extras=writeGltf(preferred);
const manifest={schemaVersion:1,source:"scenery/term4.BGL",sourceBytes:data.length,sourceSha256:await (async()=>{const {createHash}=await import("node:crypto");return createHash("sha256").update(data).digest("hex");})(),embeddedModelCount:entries.length,models:parsed.map((m)=>({name:m.name,error:m.error??null,parts:m.parts?.length??0,vertexBuffers:m.vertexBuffers?.map((v)=>v.length)??[],materials:m.materials?.length??0,textures:m.textures?.length??0,declaredBounds:m.declaredBounds??null})),selectedModel:preferred.name,output:extras};
fs.writeFileSync(path.join(outputDir,"extraction-manifest.json"),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
