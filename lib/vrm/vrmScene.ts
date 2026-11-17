import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { buildHumanoidRig } from "./humanoidRigger";
import type { AvatarPreset } from "./avatarPresets";
import {
  avatarFromRiggedModel,
  avatarFromVRM,
  type AvatarSource,
  type MotionAvatar,
} from "./motionAvatar";

export type BgStyle = "dark" | "chromakey" | "transparent" | "gradient";

/** Wires a preset's texture table onto the loaded materials by material name.
 * Needed because the FBX carries no texture references of its own. */
function applyPresetTextures(root: THREE.Object3D, preset: AvatarPreset) {
  const base = preset.textureBase ?? "";
  const rules = new Map((preset.textures ?? []).map((r) => [r.material, r]));
  const loader = new THREE.TextureLoader();
  const cache = new Map<string, THREE.Texture>();

  const load = (file: string, srgb: boolean) => {
    const key = `${file}|${srgb}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const tex = loader.load(base + file);
    // FBX/OBJ pipelines expect three's default flipY; only glTF wants it off.
    if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
    cache.set(key, tex);
    return tex;
  };

  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) {
      const rule = mat && rules.get(mat.name);
      if (!rule) continue;
      const m = mat as THREE.MeshPhongMaterial;
      if (rule.baseColor) {
        m.map = load(rule.baseColor, true);
        // The loader tints materials from the FBX's own diffuse color, which
        // would multiply against (and darken) the base color map.
        m.color?.setRGB(1, 1, 1);
      }
      if (rule.normal) m.normalMap = load(rule.normal, false);
      m.needsUpdate = true;
    }
  });
}

/** Picks the loader from a filename or URL. Defaults to the glTF/VRM path. */
export function detectAvatarFormat(nameOrUrl: string): AvatarSource {
  const lower = nameOrUrl.toLowerCase().split("?")[0];
  if (lower.endsWith(".fbx")) return "fbx";
  if (lower.endsWith(".vrm")) return "vrm";
  return "gltf";
}

export class VRMSceneManager {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private currentAvatar: MotionAvatar | null = null;
  private clock: THREE.Clock;
  private animId: number | null = null;
  private framing: "full" | "upper" = "upper";

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.clock = new THREE.Clock();

    // 1. Renderer Setup
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // 2. Scene Setup
    this.scene = new THREE.Scene();
    this.setBgStyle("dark");

    // 3. Camera
    this.camera = new THREE.PerspectiveCamera(
      35,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      20
    );
    // Pulled back + slightly lower so the upper body and raised/lowered arms
    // stay in frame (motion capture needs to see the limbs move).
    this.camera.position.set(0, 1.15, 2.9);

    // 4. Lights
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(1, 2, 1.5);
    this.scene.add(dirLight);

    const ambLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambLight);

    // 5. Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.0, 0);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;

    // 6. Start Loop
    this.startLoop();
  }

  public setBgStyle(style: BgStyle) {
    switch (style) {
      case "chromakey":
        this.scene.background = new THREE.Color(0x00ff00);
        break;
      case "transparent":
        this.scene.background = null;
        break;
      case "gradient":
      case "dark":
      default:
        this.scene.background = new THREE.Color(0x0f111e);
        break;
    }
  }

  /** Loads an avatar. `.vrm` and `.glb/.gltf` go through GLTFLoader (with the VRM
   * plugin), `.fbx` through FBXLoader; anything that isn't a real VRM is adapted
   * to a VRM humanoid by buildHumanoidRig(). `nameHint` supplies the extension
   * when the source is an ArrayBuffer (i.e. a user upload). */
  public async loadAvatar(
    urlOrBuffer: string | ArrayBuffer,
    nameHint?: string,
    preset?: AvatarPreset
  ): Promise<MotionAvatar> {
    const hint = nameHint ?? (typeof urlOrBuffer === "string" ? urlOrBuffer : "");
    const format = detectAvatarFormat(hint);

    const avatar =
      format === "fbx"
        ? await this.loadFbxAvatar(urlOrBuffer)
        : await this.loadGltfAvatar(urlOrBuffer);

    if (preset?.textures && preset.textureBase) {
      applyPresetTextures(avatar.scene, preset);
    }

    this.installAvatar(avatar);
    return avatar;
  }

  /** Loads one of the built-in avatars, wiring its texture table if it has one. */
  public loadPreset(preset: AvatarPreset): Promise<MotionAvatar> {
    return this.loadAvatar(preset.url, preset.url, preset);
  }

  private async loadGltfAvatar(urlOrBuffer: string | ArrayBuffer): Promise<MotionAvatar> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const gltf = await new Promise<any>((resolve, reject) => {
      if (typeof urlOrBuffer === "string") {
        loader.load(urlOrBuffer, resolve, undefined, reject);
      } else {
        loader.parse(urlOrBuffer, "", resolve, reject);
      }
    });

    const vrm: VRM | undefined = gltf.userData?.vrm;
    if (vrm) {
      VRMUtils.rotateVRM0(vrm);
      return avatarFromVRM(vrm);
    }

    // A plain glTF/glb humanoid: same adapter path as FBX.
    const rig = buildHumanoidRig(gltf.scene);
    return avatarFromRiggedModel(gltf.scene, rig, "gltf");
  }

  private async loadFbxAvatar(urlOrBuffer: string | ArrayBuffer): Promise<MotionAvatar> {
    const loader = new FBXLoader();
    const root =
      typeof urlOrBuffer === "string"
        ? await new Promise<THREE.Group>((resolve, reject) =>
            loader.load(urlOrBuffer, resolve, undefined, reject)
          )
        : (loader.parse(urlOrBuffer, "") as THREE.Group);

    const rig = buildHumanoidRig(root);
    return avatarFromRiggedModel(root, rig, "fbx");
  }

  private installAvatar(avatar: MotionAvatar) {
    if (this.currentAvatar) {
      this.scene.remove(this.currentAvatar.scene);
      for (const extra of this.currentAvatar.extraRoots) this.scene.remove(extra);
      VRMUtils.deepDispose(this.currentAvatar.scene);
    }

    this.currentAvatar = avatar;
    this.scene.add(avatar.scene);
    // The adapted rig's bone offsets are absolute world positions, so its root
    // has to sit in the scene at identity — never under the (scaled) model root.
    for (const extra of avatar.extraRoots) this.scene.add(extra);

    this.frameAvatar();
  }

  /** Aims the camera at the avatar. "upper" pulls in to a bust framing for the
   * face+hands mode; "full" keeps the wider body shot. */
  public setFraming(framing: "full" | "upper") {
    this.framing = framing;
    this.frameAvatar();
  }

  private frameAvatar() {
    const headNode = this.currentAvatar?.humanoid?.getRawBoneNode("head");
    if (!headNode) return;

    const headPos = new THREE.Vector3();
    headNode.getWorldPosition(headPos);

    if (this.framing === "upper") {
      // Chest-up: the face carries the performance here, and hands are raised
      // into this area anyway.
      this.controls.target.set(headPos.x, headPos.y - 0.18, headPos.z);
      this.camera.position.set(headPos.x, headPos.y - 0.05, headPos.z + 1.35);
    } else {
      this.controls.target.set(headPos.x, headPos.y - 0.4, headPos.z);
      this.camera.position.set(0, 1.15, 2.9);
    }
    this.controls.update();
  }

  public getAvatar(): MotionAvatar | null {
    return this.currentAvatar;
  }

  public resize(width: number, height: number) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  public takeSnapshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL("image/png");
  }

  private startLoop() {
    const render = () => {
      this.animId = requestAnimationFrame(render);
      const delta = this.clock.getDelta();

      if (this.currentAvatar) {
        this.currentAvatar.update(delta);
      }

      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    render();
  }

  public dispose() {
    if (this.animId !== null) {
      cancelAnimationFrame(this.animId);
    }
    if (this.currentAvatar) {
      this.scene.remove(this.currentAvatar.scene);
      for (const extra of this.currentAvatar.extraRoots) this.scene.remove(extra);
      VRMUtils.deepDispose(this.currentAvatar.scene);
    }
    this.renderer.dispose();
  }
}
