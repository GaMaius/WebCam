import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type BgStyle = "dark" | "chromakey" | "transparent" | "gradient";

export class VRMSceneManager {
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private currentVRM: VRM | null = null;
  private clock: THREE.Clock;
  private animId: number | null = null;

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
    this.camera.position.set(0, 1.4, 2.2);

    // 4. Lights
    const dirLight = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight.position.set(1, 2, 1.5);
    this.scene.add(dirLight);

    const ambLight = new THREE.AmbientLight(0xffffff, 0.8);
    this.scene.add(ambLight);

    // 5. Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 1.2, 0);
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

  public async loadVRM(urlOrBuffer: string | ArrayBuffer): Promise<VRM> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    return new Promise((resolve, reject) => {
      const onLoad = (gltf: any) => {
        const vrm: VRM = gltf.userData.vrm;
        if (!vrm) {
          reject(new Error("Failed to load VRM model metadata"));
          return;
        }

        // Clean up previous VRM
        if (this.currentVRM) {
          this.scene.remove(this.currentVRM.scene);
          VRMUtils.deepDispose(this.currentVRM.scene);
        }

        // Setup current VRM
        this.currentVRM = vrm;
        VRMUtils.rotateVRM0(vrm);
        this.scene.add(vrm.scene);

        // Adjust camera target
        const headNode = vrm.humanoid?.getRawBoneNode("head");
        if (headNode) {
          const headPos = new THREE.Vector3();
          headNode.getWorldPosition(headPos);
          this.controls.target.copy(headPos);
        }

        resolve(vrm);
      };

      if (typeof urlOrBuffer === "string") {
        loader.load(urlOrBuffer, onLoad, undefined, reject);
      } else {
        loader.parse(urlOrBuffer, "", onLoad, reject);
      }
    });
  }

  public getVRM(): VRM | null {
    return this.currentVRM;
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

      if (this.currentVRM) {
        this.currentVRM.update(delta);
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
    if (this.currentVRM) {
      this.scene.remove(this.currentVRM.scene);
      VRMUtils.deepDispose(this.currentVRM.scene);
    }
    this.renderer.dispose();
  }
}
