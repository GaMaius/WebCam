// Turns a raw third-party avatar download into web-sized assets.
//
// The Sketchfab-style download is unusable on the web as-is: 4096x4096 PNG maps
// (one normal map alone is 57MB, ~636MB for the set) and an FBX that references
// no textures at all, so the maps have to be wired to materials by name.
//
// This writes public/models/spiderman/ (committed) from
// public/models/spider-man-brand-new-day/ (gitignored). Re-run after replacing
// the raw download.
//
//   node scratch/build_avatar_assets.mjs

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SRC = "public/models/spider-man-brand-new-day";
const OUT = "public/models/spiderman";
const SRC_FBX = path.join(SRC, "source", "Spider-Man Brand New Day.fbx");
const SRC_TEX = path.join(SRC, "textures");

// Only the maps the renderer actually samples. FBXLoader builds MeshPhong
// materials, which have no metalness/roughness slots, so those maps are dropped.
const KEEP = [
  { match: /_BaseColor\./, size: 1024, quality: 82 },
  { match: /_Normal\./, size: 1024, quality: 80 },
  { match: /_Alpha\./, size: 512, quality: 80 },
];

async function main() {
  if (!fs.existsSync(SRC_FBX)) {
    console.error(`missing raw download: ${SRC_FBX}`);
    process.exit(1);
  }

  fs.mkdirSync(path.join(OUT, "tex"), { recursive: true });

  // 1) FBX: copied as-is (31MB). No tool here can convert FBX->glTF.
  const fbxOut = path.join(OUT, "spiderman.fbx");
  fs.copyFileSync(SRC_FBX, fbxOut);
  console.log(`fbx  ${(fs.statSync(fbxOut).size / 1048576).toFixed(1)}MB -> ${fbxOut}`);

  // 2) Textures: downscale to WebP.
  const files = fs.readdirSync(SRC_TEX).filter((f) => /\.png$/i.test(f));
  let srcTotal = 0;
  let outTotal = 0;
  let kept = 0;

  for (const file of files) {
    const srcPath = path.join(SRC_TEX, file);
    srcTotal += fs.statSync(srcPath).size;

    const rule = KEEP.find((k) => k.match.test(file));
    if (!rule) continue;

    const outPath = path.join(OUT, "tex", file.replace(/\.png$/i, ".webp"));
    await sharp(srcPath)
      .resize(rule.size, rule.size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: rule.quality })
      .toFile(outPath);

    const size = fs.statSync(outPath).size;
    outTotal += size;
    kept++;
    console.log(`tex  ${file} -> ${path.basename(outPath)}  ${(size / 1024).toFixed(0)}KB`);
  }

  console.log(
    `\n${kept}/${files.length} textures kept: ${(srcTotal / 1048576).toFixed(0)}MB -> ` +
      `${(outTotal / 1048576).toFixed(1)}MB`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
