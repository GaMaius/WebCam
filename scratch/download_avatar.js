import fs from 'fs';
import path from 'path';

const SAMPLE_VRM_URLS = [
  'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Sample.vrm',
  'https://pixiv.github.io/three-vrm/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm',
  'https://raw.githubusercontent.com/yeemachine/kalidoface-3d/main/public/models/Asahi.vrm',
  'https://cdn.jsdelivr.net/gh/yeemachine/kalidoface-3d@main/public/models/Asahi.vrm',
  'https://raw.githubusercontent.com/vrm-c/vrm-specification/master/specification/VRMC_vrm-1.0/samples/VRM1_Constraint_Sample.vrm'
];

async function downloadSample() {
  const destDir = path.join(process.cwd(), 'public', 'models');
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const destPath = path.join(destDir, 'avatar.vrm');
  console.log('Target VRM path:', destPath);

  for (const url of SAMPLE_VRM_URLS) {
    try {
      console.log('Trying download from:', url);
      const res = await fetch(url);
      if (res.ok) {
        const buffer = await res.arrayBuffer();
        if (buffer.byteLength > 1000) {
          fs.writeFileSync(destPath, Buffer.from(buffer));
          console.log(`Successfully saved VRM model (${buffer.byteLength} bytes) to ${destPath}`);
          return;
        }
      } else {
        console.warn(`HTTP status ${res.status} for ${url}`);
      }
    } catch (e) {
      console.warn('Failed url:', url, e.message);
    }
  }
  console.error('All sample VRM download attempts failed.');
}

downloadSample();
